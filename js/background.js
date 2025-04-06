const CurryPartyBackground = (() => {
  'use strict';

  // Track known streaming sites for quick updates
  const SUPPORTED_DOMAINS = [
    '*://*.netflix.com/*',
    '*://*.hotstar.com/*',
    '*://*.primevideo.com/*',
    '*://*.youtube.com/*',
    '*://*.disneyplus.com/*',
    '*://*.hulu.com/*',
    '*://*.hbomax.com/*',
    '*://*.max.com/*'
  ];

  // =========================================================
  // Room Manager: handles current room state, storage, etc.
  // =========================================================
  const RoomManager = {
    currentRoomId: null,
    isHost: false,
    participantCount: 1,
    roomUrl: null,

    init() {
      // Restore from local storage if existing
      chrome.storage.local.get(['roomId', 'isHost', 'participantCount', 'roomUrl'], (result) => {
        if (result.roomId) {
          console.log('CurryParty (bg): Restoring room state:', result);
          this.currentRoomId = result.roomId;
          this.isHost = !!result.isHost;
          this.participantCount = result.participantCount || 1;
          this.roomUrl = result.roomUrl || null;
          // After a short delay, notify content scripts so they can reconnect
          setTimeout(() => {
            BroadcastHelper.notifyAllTabsOfRoomChange();
          }, 2000);
        }
      });
    },

    createRoom(roomId, url, callback) {
      console.log('CurryParty (bg): Creating new room:', roomId, 'for URL:', url);
      
      // Extract base URL (before query parameters)
      const baseUrl = url ? this.getBaseUrl(url) : null;

      // Store room state
      this.currentRoomId = roomId;
      this.isHost = true;
      this.participantCount = 1;
      this.roomUrl = baseUrl;

      chrome.storage.local.remove([
        'roomId', 'isHost', 'participantCount', 'roomUrl',
        'lastSuccessfulHostId', 'lastRejectedHostId',
        'lastHostId', 'hostPeerId', 'hostRetryCount'
      ], () => {
        chrome.storage.local.set({
          roomId: roomId,
          isHost: true,
          participantCount: 1,
          roomUrl: baseUrl,
          createdAt: Date.now()
        }, () => {
          console.log(`CurryParty (bg): Room created [${roomId}] & saved to storage with URL ${baseUrl}`);
          // Inform content scripts
          BroadcastHelper.notifyAllTabsOfRoomChange();
          if (callback) callback({ success: true, roomId: roomId, roomUrl: baseUrl });
        });
      });
    },

    joinRoom(roomId, callback) {
      console.log('CurryParty (bg): Joining room:', roomId);
      this.currentRoomId = roomId;
      this.isHost = false;
      this.participantCount = 1;
      // URL will be retrieved from host during connection

      chrome.storage.local.set({
        roomId: roomId,
        isHost: false,
        participantCount: 1
      }, () => {
        console.log('CurryParty (bg): Joined room & saved to storage:', roomId);
        // Inform content scripts
        BroadcastHelper.notifyAllTabsOfRoomChange();
        if (callback) callback({ success: true, pending: true });
      });
    },
    
    getBaseUrl(url) {
      // Extract base URL (remove query parameters, fragments)
      try {
        const parsedUrl = new URL(url);
        // Get URL up to the path, but remove query parameters or hash
        const queryPos = parsedUrl.href.indexOf('?');
        if (queryPos !== -1) {
          return parsedUrl.href.substring(0, queryPos);
        }
        // Remove hash part if exists
        const hashPos = parsedUrl.href.indexOf('#');
        if (hashPos !== -1) {
          return parsedUrl.href.substring(0, hashPos);
        }
        return parsedUrl.href;
      } catch (e) {
        console.error('CurryParty (bg): Error parsing URL:', e);
        return url;
      }
    },
    
    setRoomUrl(url) {
      const baseUrl = this.getBaseUrl(url);
      this.roomUrl = baseUrl;
      chrome.storage.local.set({ roomUrl: baseUrl });
      console.log('CurryParty (bg): Room URL set to:', baseUrl);
      return baseUrl;
    },

    leaveRoom(roomId) {
      if (roomId !== this.currentRoomId) return;
      console.log('CurryParty (bg): Leaving room:', roomId);

      this.currentRoomId = null;
      this.isHost = false;
      this.participantCount = 1;
      this.roomUrl = null;

      chrome.storage.local.remove(['roomId', 'isHost', 'participantCount', 'roomUrl'], () => {
        console.log('CurryParty (bg): Room data cleared from storage');
      });

      BroadcastHelper.notifyAllTabsOfRoomChange();
    },

    updateParticipantCount(count) {
      this.participantCount = count;
      chrome.storage.local.set({ participantCount: count }, () => {
        console.log('CurryParty (bg): Updated participant count in storage:', count);
      });

      // Also broadcast to popup if open
      try {
        chrome.runtime.sendMessage({
          action: 'updateParticipantCount',
          count: this.participantCount
        });
      } catch (err) {
        console.log('CurryParty (bg): Could not update popup (likely closed)');
      }
    }
  };

  // =========================================================
  // Tab Manager: track streaming site tabs & help with messaging
  // =========================================================
  const TabManager = {
    tabRegistry: {},

    init() {
      // Listen for updated tabs
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete') {
          this.handleTabUpdate(tabId, tab);
        }
      });

      // Listen for removed tabs
      chrome.tabs.onRemoved.addListener((tabId) => {
        delete this.tabRegistry[tabId];
      });
    },

    handleTabUpdate(tabId, tab) {
      if (!tab || !tab.url) return;
      // Check if domain is supported
      const isSupported = SUPPORTED_DOMAINS.some(domainPattern => {
        // Rough check, or do more advanced matching
        return tab.url.includes(domainPattern.replace('*://*.', '').replace('/*', ''));
      });
      if (isSupported) {
        this.tabRegistry[tabId] = tab.url;
      } else {
        delete this.tabRegistry[tabId];
      }
    },

    async refreshTabRegistry() {
      console.log('CurryParty (bg): Refreshing tab registry...');
      this.tabRegistry = {};
      try {
        const tabs = await chrome.tabs.query({ url: SUPPORTED_DOMAINS });
        tabs.forEach(t => {
          this.tabRegistry[t.id] = t.url;
        });
        console.log(`CurryParty (bg): Found ${tabs.length} streaming tabs.`);
      } catch (err) {
        console.error('CurryParty (bg): Error refreshing tabs:', err);
      }
    },

    getAllTabIds() {
      return Object.keys(this.tabRegistry).map(Number);
    }
  };

  // =========================================================
  // Broadcast Helper: simplifies sending to all content scripts
  // =========================================================
  const BroadcastHelper = {
    async notifyAllTabsOfRoomChange() {
      console.log('CurryParty (bg): Broadcasting room change...');
      await TabManager.refreshTabRegistry();
      const allTabIds = TabManager.getAllTabIds();
      if (allTabIds.length === 0) {
        console.log('CurryParty (bg): No streaming tabs to notify');
        return;
      }
      allTabIds.forEach(tabId => this.ensureContentScriptLoadedAndNotify(tabId));
    },

    ensureContentScriptLoadedAndNotify(tabId) {
      // Ping content script to see if it's loaded
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not loaded, so inject it
          console.log(`CurryParty (bg): Injecting content script in tab ${tabId}`);
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['lib/peerjs.min.js', 'js/content.js']
          }).then(() => {
            setTimeout(() => {
              this.sendRoomUpdate(tabId);
            }, 1000);
          }).catch(err => {
            console.error(`CurryParty (bg): Failed injecting script into ${tabId} - `, err);
          });
        } else {
          this.sendRoomUpdate(tabId);
        }
      });
    },

    sendRoomUpdate(tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'roomUpdate',
        roomId: RoomManager.currentRoomId,
        isHost: RoomManager.isHost,
        roomUrl: RoomManager.roomUrl
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error(`CurryParty (bg): roomUpdate to tab ${tabId} errored:`, chrome.runtime.lastError);
        } else if (response && response.success) {
          console.log(`CurryParty (bg): roomUpdate to tab ${tabId} success`);
        }
      });
    },

    relayVideoEvent(request, senderTabId) {
      const allTabIds = TabManager.getAllTabIds();
      allTabIds.forEach(tabId => {
        if (tabId !== senderTabId) {
          // Attempt to ping, then send event
          chrome.tabs.sendMessage(tabId, { action: 'ping' }, (resp) => {
            if (!chrome.runtime.lastError) {
              chrome.tabs.sendMessage(tabId, {
                action: 'videoCommand',
                eventType: request.eventType,
                data: request.data
              });
            }
          });
        }
      });
    }
  };

  const UserManager = {
    generateUserId() {
      this.userId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    },
    getUserId() {
      return this.userId;
    },
    setUserId(userId) {
      this.userId = userId;
      chrome.storage.local.set({ userId });
    },
    init() {
      chrome.storage.local.get(['userId'], (result) => {
        if (result.userId) {
          this.userId = result.userId;
        } else {
          this.generateUserId();
          chrome.storage.local.set({ userId: this.userId });
        }
      });

      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'getUserId') {
          sendResponse({ userId: this.userId });
        }
      });
    }
  };

  // =========================================================
  // Master init
  // =========================================================
  function init() {
    console.log('CurryParty (bg): Initializing...');
    RoomManager.init();
    TabManager.init();
    UserManager.init();
  }

  // =========================================================
  // Handle messages
  // =========================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const { action } = request;
    switch (action) {
      case 'createRoom':
        RoomManager.createRoom(request.roomId, request.url, sendResponse);
        return true; // to indicate async
      case 'joinRoom':
        RoomManager.joinRoom(request.roomId, sendResponse);
        return true;
      case 'setRoomUrl':
        const baseUrl = RoomManager.setRoomUrl(request.url);
        sendResponse({ success: true, roomUrl: baseUrl });
        return true;
      case 'leaveRoom':
        RoomManager.leaveRoom(request.roomId);
        sendResponse({ success: true });
        return true;
      case 'videoEvent':
        BroadcastHelper.relayVideoEvent(request, sender.tab?.id);
        sendResponse({ success: true });
        return true;
      case 'getParticipantCount':
        sendResponse({ count: RoomManager.participantCount });
        return true;
      case 'getCurrentRoom':
        sendResponse({
          roomId: RoomManager.currentRoomId,
          isHost: RoomManager.isHost,
          roomUrl: RoomManager.roomUrl
        });
        return true;
      case 'updateParticipantCount':
        RoomManager.updateParticipantCount(request.count);
        sendResponse({ success: true });
        return true;
      case 'roleChange':
        if (request.roomId === RoomManager.currentRoomId) {
          RoomManager.isHost = request.isHost;
          chrome.storage.local.set({ isHost: request.isHost });
        }
        sendResponse({ success: true });
        return true;
    }
    return false;
  });

  // Initialize immediately
  init();

  // Expose only if you want to debug from devtools
  return {
    RoomManager,
    TabManager,
    BroadcastHelper
  };
})();