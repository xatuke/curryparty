// Configuration template for Curry Party
// IMPORTANT: Copy this file to config.js and edit with your own TURN/STUN credentials
// config.js is not included in git to keep credentials private

const CurryPartyConfig = {
  // WebRTC ICE Servers Configuration
  // Replace with your own TURN/STUN servers for production use
  iceServers: [
    {
      urls: "stun:stun.relay.metered.ca:80",
    },
    {
      // Example TURN configuration - replace with your own credentials
      urls: "turn:your.turn.server:port",
      username: "your-username",
      credential: "your-credential",
    },
    {
      urls: "turn:your.turn.server:port?transport=tcp",
      username: "your-username",
      credential: "your-credential",
    },
  ]
};