import express, { response } from "express";
import cors from "cors";
import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";
import { https } from "firebase-functions";

// CONSTANTS
const PER_PAGE = 100;

// Read env vars (for local)
// On Firebase, env vars will be applied
dotenv.config();

// Initialize Redis client
const redisClient = createClient({
  url: "redis://redis-14437.c62.us-east-1-4.ec2.cloud.redislabs.com:14437",
  password: "fofsW2tllOxblIdFsHylohfBSagsYA2y",
});

// Connect to redis instance
(async () => {
  await redisClient.connect();
})();

// Initialize App
const app = express();

// Middlewares
app.use(cors({ origin: "*" }));

function validateQueryParams(username, fork) {
  // username value is invalid
  if (username === undefined || username === null) {
    return {
      valid: false,
      errMsg: "ERROR: Invalid username value",
    };
  }

  // fork value is invalid
  if (fork !== undefined && fork !== null && fork !== true && fork !== false) {
    return {
      valid: false,
      errMsg: "ERROR: Invalid username value",
    };
  }

  return { valid: true };
}

function simplifyFork(fork) {
  if (fork === undefined || fork === null || fork === true) {
    return true;
  }

  return false;
}

async function getReposDataObj(URL, etag) {
  const reposDataObj = await axios({
    url: URL,
    method: "GET",
    headers: {
      Authorization: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      "If-None-Match": etag == null ? "" : etag,
    },
  }).catch((error) => {
    if (error.response.status === 304) {
      // Not Modified
      return 304;
    } else if (error.response.status === 404) {
      // Not Found
      return 404;
    }
  });

  return reposDataObj;
}

function checkForBadRequest(axiosResponse) {
  let badRequest = false;
  if (axiosResponse === 404) {
    badRequest = true;
  }

  return badRequest;
}

function sendBadRequestResponse(res) {
  res.status(400).send("ERROR: Username doesn't exist");
}

async function checkForNotModified(axiosResponse) {
  let notModified = false;
  if (axiosResponse === 304) {
    notModified = true;
  }

  return notModified;
}

async function sendCachedResults(username_fork_key, res) {
  // Get previously cached response object
  const responseObj = await redisClient
    .GET(username_fork_key)
    .then((data) => JSON.parse(data))
    .catch((error) => console.error("REDIS ERROR: ", error));

  res.status(200).json(responseObj);
}

async function processReposData(repos, aggregateValues) {
  let { reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize, langList } =
    aggregateValues;

  repos.forEach(async (repo) => {
    reposCount += 1;
    stargazersTotalCount += repo["stargazers_count"];
    forksTotalCount += repo["forks_count"];
    totalRepoSize += repo["size"];

    // Get languages
    const { data: languagesObj } = await axios({
      method: "get",
      url: repo.languages_url,
      headers: {
        Authorization: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      },
    }).catch((error) => {
      console.error("* ERROR in fetching languages: ", error);
    });

    // Populate langList by iterating through languesObj
    for (const [name, count] of Object.entries(languagesObj)) {
      const langMatchIndex = langList.findIndex((lang) => lang.name === name);

      // language is not found in langList
      if (langMatchIndex === -1) {
        langList.push({
          name: name,
          count: count,
        });
      }
      // language is in langList, replace itself with updated count
      else {
        let updatedLang = langList[langMatchIndex];
        updatedLang.count += count;
        langList.splice(langMatchIndex, 1, updatedLang);
      }
    }
  }); // END OF repos.forEach()

  return [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize];
}

async function processReposDataObj(reposDataObj, aggregateValues) {
  const repos = reposDataObj.data;
  return processReposData(repos, aggregateValues);
}

async function processCachedReposData(cachedEtag, aggregateValues) {
  const cachedReposData = await redisClient
    .HGET(username_fork_key + "-" + "HASH", cachedEtag)
    .then((data) => JSON.parse(data))
    .catch((error) => console.error("REDIS ERROR: ", error));

  return processReposData(cachedReposData, aggregateValues);
}

function getAvgRepoSize(totalRepoSize, reposCount) {
  // Compute avg repo size (in KB by default)
  let avgRepoSize = totalRepoSize / reposCount;

  // Convert into appropriate unit (KB, MB, GB)
  if (avgRepoSize >= 1000) {
    avgRepoSize = (avgRepoSize / 1000).toFixed(3); // MB
  } else if (avgRepoSize >= 1000 * 1000) {
    avgRepoSize = (avgRepoSize / (1000 * 1000)).toFixed(3); // GB
  }

  return avgRepoSize;
}

async function renewAllCache(
  username_fork_key,
  newEtagsPageNumList,
  newEachEtagPageHash,
  newResponseObj
) {
  // renew etag=page number LIST
  await redisClient
    .DEL(username_fork_key + "-" + "LIST")
    .catch((error) => console.error("REDIS ERROR: ", error));
  newEtagsPageNumList.forEach(async (etagsPageNumPair) => {
    await redisClient
      .RPUSH(username_fork_key + "-" + "LIST", JSON.stringify(etagsPageNumPair))
      .catch((error) => console.error("REDIS ERROR: ", error));
  });

  // renew etag: reposPage HASH
  await redisClient
    .DEL(username_fork_key + "-" + "HASH")
    .catch((error) => console.error("REDIS ERROR: ", error));
  for (const [key, value] of Object.entries(newEachEtagPageHash)) {
    await redisClient
      .HSET(username_fork_key + "-" + "HASH", JSON.stringify(key), JSON.stringify(value))
      .catch((error) => console.error("REDIS ERROR: ", error));
  }

  // renew response object
  await redisClient
    .SET(username_fork_key, JSON.stringify(newResponseObj))
    .catch((error) => console.error("REDIS ERROR: ", error));
}

// Get the aggregated Statistics across all repositories of given user
app.get("/aggregated-stats", async (req, res) => {
  console.log("* START OF APPLICATION");
  // Get query params
  const username = req.query.username;
  let fork = req.query.fork;

  // Data to return
  let reposCount = 0;
  let stargazersTotalCount = 0;
  let forksTotalCount = 0;
  let avgRepoSize = 0;
  let totalRepoSize = 0;
  let langList = [];

  // New cache data
  let newEtagsPageNumList = [];
  let newEachEtagPageHash = {};

  // Validate query parameters
  const { valid: queryParamsIsValid, errMsg } = validateQueryParams(username, fork);
  if (!queryParamsIsValid) {
    return res.status(400).send(errMsg);
  }

  // Prevent value of fork from being "undefined" or "null"
  fork = simplifyFork(fork);

  // Construct redis key (to store as cache) & github API URL
  const username_fork_key = [username, fork].join(", ");

  // Get etag value from redis, if there is one
  const cachedEtagsPageNumList = await redisClient
    .LRANGE(username_fork_key + "-" + "LIST", 0, -1)
    .catch((error) => console.error("REDIS ERROR: ", error));

  console.log("* FETCHED cachedEtagsPageNumList from REDIS");

  // Check if any of the cached etags results in a NO MATCH
  // If yes, the page of repos associated with that etag needs to be refetched
  let allReposEntirelyUpToDate = true;
  let lastPageNum = 0;
  let prevPageNum = 0;
  if (cachedEtagsPageNumList.length != 0) {
    console.log("*** cachedEtagsPageNumList.length != 0");
    cachedEtagsPageNumList.forEach(async (cachedEtagPageNum) => {
      const cachedEtag = cachedEtagPageNum.split("=")[0];
      const cachedPageNum = cachedEtagPageNum.split("=")[1];

      let github_API_repos_URL = `https://api.github.com/users/${username}/repos?per_page=${PER_PAGE}&page=${cachedPageNum}`;
      let reposDataObj = await getReposDataObj(github_API_repos_URL, cachedEtag);

      // Check for 404: Bad Request
      let badRequest = checkForBadRequest(reposDataObj);
      if (badRequest) {
        return sendBadRequestResponse();
      }

      prevPageNum = cachedPageNum;
      // Get last page number
      if (cachedPageNum === 1) {
        const pageRegexMatches = reposDataObj.headers.link.match(/page=\d*/g);
        const lastPageStr = pageRegexMatches[pageRegexMatches.length - 1];
        lastPageNum = lastPageStr.split("=")[1];
      }

      // Check for 304: Not Modified
      let contentUpToDate = checkForNotModified(reposDataObj);
      if (!contentUpToDate) {
        allReposEntirelyUpToDate = false;

        // Prepare for update of redis cache
        const newEtag = reposDataObj.headers.etag;
        newEtagsPageNumList.push([newEtag, cachedPageNum].join("="));
        newEachEtagPageHash[newEtag] = reposDataObj.data;

        // update aggregate data
        [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = processReposDataObj(
          reposDataObj,
          {
            reposCount,
            stargazersTotalCount,
            forksTotalCount,
            totalRepoSize,
            langList,
          }
        );
      } else if (contentUpToDate) {
        // Prepare for update of redis cache
        newEtagsPageNumList.push([cachedEtag, cachedPageNum].join("="));
        newEachEtagPageHash[cachedEtag] = await redisClient
          .HGET(username_fork_key + "-" + "HASH", cachedEtag)
          .then((data) => JSON.parse(data))
          .catch((error) => console.error("REDIS ERROR: ", error));

        // update aggregate data
        [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = processCachedReposData(
          cachedEtag,
          {
            reposCount,
            stargazersTotalCount,
            forksTotalCount,
            totalRepoSize,
            langList,
          }
        );
      }
    }); // END OF cachedEtagsPageNumList.forEach()

    // All repos across all pages are up to date. Everything can be returned from the cache
    if (allReposEntirelyUpToDate) {
      console.log("***** allReposEntirelyUpToDate");

      return sendCachedResults(username_fork_key, res);
    }
    // At least one of the pages is NOT up to date. Renew the cache and return updated content
    else {
      if (prevPageNum != lastPageNum) {
        for (let i = prevPageNum + 1; i <= lastPageNum; i++) {
          let github_API_repos_URL = `https://api.github.com/users/${username}/repos?per_page=${PER_PAGE}&page=${i}`;
          let reposDataObj = await getReposDataObj(github_API_repos_URL, null);

          // Prepare for update of redis cache
          const newEtag = reposDataObj.headers.etag;
          newEtagsPageNumList.push([newEtag, ""+i].join("="));
          newEachEtagPageHash[newEtag] = reposDataObj.data;

          // update aggregate data
          [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = processReposDataObj(
            reposDataObj,
            {
              reposCount,
              stargazersTotalCount,
              forksTotalCount,
              totalRepoSize,
              langList,
            }
          );
        }
      }
    } // END OF allReposEntirelyUpToDate == false
  } // END OF cachedEtagsList != null
  else if (cachedEtagsPageNumList.length == 0) {
    console.log("*** cachedEtagsPageNumList.length == 0");

    allReposEntirelyUpToDate = false;

    let github_API_repos_URL = `https://api.github.com/users/${username}/repos?per_page=${PER_PAGE}&page=${1}`;
    let reposDataObj = await getReposDataObj(github_API_repos_URL, null);

    // Check for 404: Bad Request
    let badRequest = checkForBadRequest(reposDataObj);
    if (badRequest) {
      return sendBadRequestResponse();
    }

    // Prepare for update of redis cache
    const newEtag = reposDataObj.headers.etag;
    newEtagsPageNumList.push([newEtag, "1"].join("="));
    newEachEtagPageHash[newEtag] = reposDataObj.data;

    // update aggregate data
    [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = processReposDataObj(
      reposDataObj,
      {
        reposCount,
        stargazersTotalCount,
        forksTotalCount,
        totalRepoSize,
        langList,
      }
    );

    // Check if more pages have to be fetched
    if (reposDataObj.headers.link !== undefined) {
      // Get last page number
      const pageRegexMatches = reposDataObj.headers.link.match(/page=\d*/g);
      const lastPageStr = pageRegexMatches[pageRegexMatches.length - 1];
      lastPageNum = lastPageStr.split("=")[1];

      for (let i = 2; i <= lastPageNum; i++) {
        console.log("***** LOOP: remaining pages");
        let github_API_repos_URL = `https://api.github.com/users/${username}/repos?per_page=${PER_PAGE}&page=${i}`;
        let reposDataObj = await getReposDataObj(github_API_repos_URL, null);

        // Prepare for update of redis cache
        const newEtag = reposDataObj.headers.etag;
        newEtagsPageNumList.push([newEtag, ""+i].join("="));
        newEachEtagPageHash[newEtag] = reposDataObj.data;

        // update aggregate data
        [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = processReposDataObj(
          reposDataObj,
          {
            reposCount,
            stargazersTotalCount,
            forksTotalCount,
            totalRepoSize,
            langList,
          }
        );
      }
    }
  }

  console.log("* BIG BRANCHES DONE => BEFORE avgRepoSize");

  // Compute the average repo size
  avgRepoSize = getAvgRepoSize(totalRepoSize, reposCount);

  // Sort langList by count (most used to least used)
  langList.sort((a, b) => {
    return b.count - a.count;
  });

  const responseObj = {
    reposCount,
    stargazersTotalCount,
    forksTotalCount,
    avgRepoSize,
    langList,
  };

  if (!allReposEntirelyUpToDate) {
    // Renew all redis cache
    renewAllCache(username_fork_key, newEtagsPageNumList, newEachEtagPageHash, responseObj);
  }

  return res.status(200).json(responseObj);
});

export const cloudApp = https.onRequest(app);
