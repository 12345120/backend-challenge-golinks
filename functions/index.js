import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { https } from "firebase-functions";

// CONSTANTS
const PER_PAGE = 100;

// Read env vars (for local)
// On Firebase, env vars will be applied
dotenv.config();

// Initialize App
const app = express();

// Middlewares
app.use(cors({ origin: "*" }));

function simplifyFork(forkStr) {
  if (forkStr === undefined || forkStr === null) {
    return true;
  }

  let fork = forkStr.toLowerCase();
  if (fork === "false") {
    return false;
  } else if (fork === "true") {
    return true;
  }

  return forkStr;
}

function validateQueryParams(username, fork) {
  // username value is invalid
  if (username === undefined || username === null) {
    return {
      valid: false,
      errMsg: "ERROR: Invalid username value",
    };
  }

  // fork value is invalid
  if (!(fork === undefined || fork === null || fork === true || fork === false)) {
    return {
      valid: false,
      errMsg: "ERROR: Invalid fork value",
    };
  }

  return { valid: true };
}

async function getReposDataObj(URL) {
  const reposDataObj = await axios({
    url: URL,
    method: "GET",
    headers: {
      Authorization: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    },
  }).catch((error) => {
    // Not Found
    if (error.response.status === 404) {
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
  res.status(400).send("ERROR: username doesn't exist");
}

async function processReposData(repos, aggregateValues, fork) {
  let { reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize, langList } =
    aggregateValues;

  for (const repo of repos) {
    if (fork === false && repo.fork === true) {
      continue;
    }

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
  } // END OF repos.forEach()

  return [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize];
}

async function processReposDataObj(reposDataObj, aggregateValues, fork) {
  const repos = reposDataObj.data;
  return await processReposData(repos, aggregateValues, fork);
}

function getLastPageNum(reposDataObj) {
  const pageRegexMatches = reposDataObj.headers.link.match(/page=\d*/g);
  const lastPageStr = pageRegexMatches[pageRegexMatches.length - 1];
  const lastPageNum = lastPageStr.split("=")[1];

  return lastPageNum;
}

function getAvgRepoSize(totalRepoSize, reposCount) {
  // Compute avg repo size (in KB by default)
  let avgRepoSize = totalRepoSize / reposCount;

  // Convert into appropriate unit (KB, MB, GB)
  if (avgRepoSize >= 1000) {
    avgRepoSize = (avgRepoSize / 1000).toFixed(3); // MB
    avgRepoSize = avgRepoSize + " MB";
  } else if (avgRepoSize >= 1000 * 1000) {
    avgRepoSize = (avgRepoSize / (1000 * 1000)).toFixed(3); // GB
    avgRepoSize = avgRepoSize + " GB";
  } else {
    avgRepoSize = avgRepoSize + " KB";
  }

  return avgRepoSize;
}

// Get the aggregated Statistics across all repositories of given user
app.get("/aggregated-stats", async (req, res) => {
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

  // Prevent value of fork from being "undefined" or "null" or other values
  fork = simplifyFork(fork);

  // Validate query parameters
  const { valid: queryParamsIsValid, errMsg } = validateQueryParams(username, fork);
  if (!queryParamsIsValid) {
    return res.status(400).send(errMsg);
  }

  let lastPageNum = 1;
  let github_API_repos_URL = `https://api.github.com/users/${username}/repos?per_page=${PER_PAGE}&page=${1}`;
  let reposDataObj = await getReposDataObj(github_API_repos_URL, null);

  // Check for 404: Bad Request
  let badRequest = checkForBadRequest(reposDataObj);
  if (badRequest) {
    return sendBadRequestResponse(res);
  }

  // update aggregate data
  [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = await processReposDataObj(
    reposDataObj,
    {
      reposCount,
      stargazersTotalCount,
      forksTotalCount,
      totalRepoSize,
      langList,
    },
    fork
  );

  // If link header is given, there are more pages to fetch
  // Get last page number
  if (reposDataObj.headers.link !== undefined) {
    lastPageNum = getLastPageNum(reposDataObj);
  }

  // Get remaining pages
  for (let i = 2; i <= lastPageNum; i++) {
    let github_API_repos_URL = `https://api.github.com/users/${username}/repos?per_page=${PER_PAGE}&page=${i}`;
    let reposDataObj = await getReposDataObj(github_API_repos_URL, null);

    // update aggregate data
    [reposCount, stargazersTotalCount, forksTotalCount, totalRepoSize] = await processReposDataObj(
      reposDataObj,
      {
        reposCount,
        stargazersTotalCount,
        forksTotalCount,
        totalRepoSize,
        langList,
      },
      fork
    );
  }

  // Compute the average repo size
  avgRepoSize = getAvgRepoSize(totalRepoSize, reposCount);

  // Sort langList by count (most used to least used)
  langList.sort((a, b) => {
    return b.count - a.count;
  });

  // construct to-be-returned data
  const responseObj = {
    reposCount,
    stargazersTotalCount,
    forksTotalCount,
    avgRepoSize,
    langList,
  };

  return res.status(200).json(responseObj);
});

export const cloudApp = https.onRequest(app);
