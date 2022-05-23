## GoLinks Backend Challenge
Task: Build an API endpoint that returns the aggregated statistics across all of the user's repositories

## Endpoint 
- Hosted On Firebase Cloud Functions: 
  - https://us-central1-golinks-backend-challenge.cloudfunctions.net/cloudApp/aggregated-stats?username={username}&fork={fork}
  - (Please replace the username and fork with actual values)


## Data Returned
- Total count of repositories
- Total stargazers for all repositories
- Total fork count for all repositories 
- Average size of a repository in the appropriate KB, MB, or GB
- A list of languages with their counts, sorted by the most used to least used

## How To Run Locally
- Download the firebase local emulators on the local machine
- Make sure you are inside the "functions" directory
- Run "npm i" to install all dependencies
- Run "firebase emulators:start" to start the local emulator 
- The Local emulator will give a URL for accessing the firebase function
- Append the endpoint "/aggregated-stats" with query parameters username and fork


## Author
Heon Yim

