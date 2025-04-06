# Curry Party - Multi-Platform Watch Party Extension

Curry Party is a Chrome extension that lets friends watch videos together across multiple streaming platforms, syncing video playback across devices using peer-to-peer technology.

## Features

- Create or join watch parties with a simple room ID
- Automatically syncs play/pause actions across all participants
- Automatically syncs seeking/skipping across all participants
- Works with multiple streaming platforms:
  - Netflix
  - Hotstar
  - Prime Video
  - YouTube
  - Disney+
  - Hulu
  - HBO Max/Max
  - AnimePahe
  - Crunchyroll
  - and more
- Minimal UI that stays out of your way
- No account required - just share the room ID with friends
- Pure peer-to-peer connection with no servers storing your data
- Lower latency compared to server-based solutions

## Setup Instructions

### For Development

1. Clone this repository to your local machine
2. Download PeerJS (version 1.4.7 or later) and save it to the `lib` folder as `peerjs.min.js`
   - You can download it from: https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js
3. Set up TURN server configuration:
   - Copy `js/config.template.js` to `js/config.js`
   - Edit `js/config.js` with your own TURN server credentials
   - Note: `config.js` is not included in git to keep credentials private
4. Open Chrome and navigate to `chrome://extensions/`
5. Enable "Developer mode" using the toggle in the top-right corner
6. Click "Load unpacked" and select the extension folder
7. The extension icon should now appear in your Chrome toolbar

### Technical Details

This extension uses PeerJS for peer-to-peer communication. The PeerJS library is included directly in the extension, and the default free PeerJS server is used for signaling only (helping peers find each other). All video synchronization data is sent directly between peers without going through any server.

#### TURN Server Configuration:

For reliable peer-to-peer connections, especially when participants are behind firewalls or certain types of NATs, the extension uses TURN servers. These servers relay traffic when a direct connection isn't possible.

- TURN server credentials are stored in `js/config.js` (not included in git)
- For deployment, you need to set up your own TURN servers or use a service like [Metered](https://www.metered.ca/tools/openrelay/) that provides TURN servers
- The template file `js/config.template.js` shows the expected format
- **Important**: All users who want to sync with each other must use the same TURN server configuration
  - If you're distributing this extension to friends for a watch party, ensure everyone is using the same configuration

#### How it works:

1. **Room Creation**:
   - One user creates a room and becomes the host
   - A unique room ID is generated to identify the session
   - The host establishes a PeerJS connection with this ID

2. **Joining a Room**:
   - Other users enter the room ID to join
   - They establish a direct P2P connection with the host
   - The host coordinates communication between all participants

3. **Video Synchronization**:
   - When you play, pause, or seek, these actions are sent to all participants
   - The host acts as the relay point for all sync messages
   - Periodic sync messages ensure everyone stays in sync even if some events are missed

## How to Use

1. Install the extension in Chrome
2. Navigate to any supported streaming platform and start a video
3. Click the extension icon in the Chrome toolbar
4. Choose to create a new room or join an existing one
5. If creating a room, share the room ID with friends
6. If joining a room, enter the room ID provided by a friend
7. Once connected, all play, pause, and seek actions will be synced with everyone in the room

## Limitations

- All participants must have valid subscriptions to the streaming service
- Content availability may vary by region - participants should have access to the same content
- Slight delays may occur depending on internet connection speeds
- The extension does not bypass any DRM or regional restrictions
- All participants must use the same TURN server configuration for reliable connectivity
  - This means you should distribute your configured extension to friends, or provide them with the same config.js file

## Technical Stack

The extension uses:
- Chrome Extension Manifest V3
- PeerJS for peer-to-peer communication
- Content scripts to interact with streaming service players
- Background service worker for managing rooms and participants

## License

This project is open source, licensed under the MIT License.