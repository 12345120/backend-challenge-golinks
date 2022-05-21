const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const Redis = require("redis");

//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });


// Initialize Redis client
const redisClient = Redis.createClient({
  url: "redis-14437.c62.us-east-1-4.ec2.cloud.redislabs.com:14437",
  password: "fofsW2tllOxblIdFsHylohfBSagsYA2y",
});

// Connect to redis instance
(async () => {
  await redisClient.connect();
})();

// Initialize App
const app = express();

// Middlewares
app.use(cors({ origin: true }));

app.get("/aggregated-stats", (req, res) => {
  // TODO:
  // Get query params
  const username = req.query.username;
  const fork = req.query.fork;

  if (fork !== undefined && fork === false) {
    // TODO:
  }

  // Call Github API to get all repos of given username

  return res.json();
});

exports.app = functions.https.onRequest(app);
