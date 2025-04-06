(function() {
  'use strict';

  // ===============================================================
  // Main object to manage state, connections, synchronization, etc.
  // ===============================================================
  const CurryPartyManager = {
    DEBUG_MODE: false,

    // State
    site: null,
    videoElement: null,
    syncEnabled: true,
    currentRoomId: null,
    isHost: false,
    participantCount: 1,
    hasInitialized: false,
    peerInitialized: false,
    userId: null,
    roomUrl: null,
    currentUrl: null,

    // P2P
    peer: null,
    connections: [],
    peerRegistry: {},
    reconnectTimer: null,
    connectionHealthCheck: null,
    lastVideoEventResponseTimestamp: 0,
    lastPongTimestamp: 0,
    livenessCheckInterval: null,

    // Tracking
    remoteSeek: false,
    remotePlay: false,
    remotePause: false,
    lastSentTime: 0,
    lastSentState: '',
    lastEventTimestamp: 0,
    lastEventType: null,
    _seekTimeout: null,

    // Intervals/Counters
    syncInterval: null,
    peerInitAttempts: 0,
    reconnectAttempts: 0,

    // UI
    statusContainer: null,
    statusIndicator: null,
    statusText: null,

    // Setup entire flow
    safeInitialize() {
      if (this.hasInitialized) {
        console.log('CurryParty: ⚠️ Already initialized, skipping');
        return;
      }
      this.hasInitialized = true;
      console.log('CurryParty: 🚀 INITIALIZING EXTENSION 🚀');
      this.initialize();
    },

    initialize() {
      // Detect site
      this.site = this.detectSite();
      if (!this.site) {
        console.log('CurryParty: No supported video found, exiting');
        // Instead of exiting immediately, we might still try scanning if the user navigates or a video appears later.
        // If you want to keep the existing exit logic, remove this block or comment it out.
        // return;
      }
      console.log('CurryParty: Initializing on', this.site);
      
      // Store current URL
      this.currentUrl = window.location.href;
      console.log('CurryParty: Current URL is', this.currentUrl);

      // Get user ID
      this.getUserId();

      // Add UI
      this.addUI();

      // Observe for video elements
      this.setupVideoObserver();

      // Use our new interval-based approach: try every 5 seconds for up to 1 minute
      this.tryFindVideoEveryInterval(12, 5000);

      // Attempt to see if we already have a room
      this.checkCurrentRoom();
      
      // Listen for URL changes
      this.setupUrlChangeListener();
    },
    
    setupUrlChangeListener() {
      // Listen for URL changes to handle navigating away from the room's URL
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      history.pushState = function(...args) {
        const result = originalPushState.apply(this, args);
        CurryPartyManager.handleUrlChange();
        return result;
      };
      
      history.replaceState = function(...args) {
        const result = originalReplaceState.apply(this, args);
        CurryPartyManager.handleUrlChange();
        return result;
      };
      
      window.addEventListener('popstate', () => {
        CurryPartyManager.handleUrlChange();
      });
      
      // Also set up a regular interval check as a fallback for sites 
      // that might use other navigation methods
      setInterval(() => {
        this.handleUrlChange();
      }, 1000);
      
      // Check initially
      this.handleUrlChange();
    },
    
    handleUrlChange() {
      const newUrl = window.location.href;
      if (newUrl !== this.currentUrl) {
        console.log('CurryParty: URL changed from', this.currentUrl, 'to', newUrl);
        this.currentUrl = newUrl;
        
        // If we're in a room and URL doesn't match room URL, handle it
        if (this.currentRoomId && this.roomUrl) {
          console.log('CurryParty: Detected URL change while in room, checking compatibility');
          this.checkUrlCompatibility();
        }
      }
    },
    
    checkUrlCompatibility() {
      // Don't do anything if not in a room or no room URL
      if (!this.currentRoomId || !this.roomUrl) {
        console.log('CurryParty: Cannot check URL compatibility - no roomId or roomUrl');
        return;
      }
      
      try {
        // Get current base URL
        const currentBaseUrl = this.getBaseUrl(this.currentUrl);
        
        console.log('CurryParty: Checking URL compatibility:', currentBaseUrl, 'vs', this.roomUrl);
        
        if (currentBaseUrl !== this.roomUrl) {
          if (this.isHost) {
            // Check if the domains are the same
            const sameDomain = this.isSameDomain(this.roomUrl, currentBaseUrl);
            console.log('CurryParty: Same domain check:', sameDomain);
            
            if (sameDomain) {
              // If host navigates to a new URL on the same domain, update room URL
              console.log('CurryParty: Host navigated to new URL on same domain, updating room URL from', this.roomUrl, 'to', currentBaseUrl);
              chrome.runtime.sendMessage({ 
                action: 'setRoomUrl', 
                url: this.currentUrl 
              }, (response) => {
                if (response && response.success) {
                  this.roomUrl = response.roomUrl;
                  
                  // For same-domain changes (likely episode changes), force redirect peers
                  console.log('CurryParty: Host moved to new page, forcing redirect for peers');
                  this.showNotification('Host moved to new page, syncing all peers...');
                  
                  // Broadcast URL change to all peers with force redirect
                  console.log('CurryParty: Broadcasting new URL to peers:', this.roomUrl);
                  this.broadcastRoomUrl();
                } else {
                  console.error('CurryParty: Failed to update room URL');
                }
              });
            } else {
              // Different domain - don't update the room URL
              console.log('CurryParty: Host navigated to different domain, not updating room URL');
            }
          } else {
            // If client navigates away, offer to redirect back
            console.log('CurryParty: Client navigated away from room URL');
            this.offerRedirectToRoomUrl();
          }
        } else {
          console.log('CurryParty: URL already matches room URL, no action needed');
        }
      } catch (e) {
        console.error('CurryParty: Error in checkUrlCompatibility:', e);
      }
    },
    
    isSameDomain(url1, url2) {
      try {
        if (!url1 || !url2) return false;
        
        const domain1 = new URL(url1).hostname;
        const domain2 = new URL(url2).hostname;
        
        return domain1 === domain2;
      } catch (e) {
        console.error('CurryParty: Error comparing domains:', e);
        return false;
      }
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
        console.error('CurryParty: Error parsing URL:', e);
        return url;
      }
    },
    
    offerRedirectToRoomUrl() {
      // Create a notification asking user if they want to go back to the room URL
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed;
        top: 70px;
        right: 20px;
        background: rgba(0,0,0,0.8);
        color: #fff;
        padding: 15px;
        border-radius: 5px;
        z-index: 10000;
        font-family: Arial, sans-serif;
        max-width: 300px;
      `;
      
      notification.innerHTML = `
        <p style="margin: 0 0 10px;">You've navigated away from the sync room URL. Do you want to return?</p>
        <div style="display: flex; justify-content: space-between;">
          <button id="curry-redirect-yes" style="background: #4CAF50; border: none; color: white; padding: 5px 10px; border-radius: 3px; cursor: pointer;">Yes</button>
          <button id="curry-redirect-no" style="background: #F44336; border: none; color: white; padding: 5px 10px; border-radius: 3px; cursor: pointer;">No</button>
        </div>
      `;
      
      document.body.appendChild(notification);
      
      document.getElementById('curry-redirect-yes').addEventListener('click', () => {
        window.location.href = this.roomUrl;
        notification.remove();
      });
      
      document.getElementById('curry-redirect-no').addEventListener('click', () => {
        notification.remove();
      });
      
      // Auto-hide after 10 seconds
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 10000);
    },
    
    broadcastRoomUrl() {
      if (!this.isHost || !this.connections || this.connections.length === 0) return;
      
      this.connections.forEach(conn => {
        if (conn && conn.open) {
          try {
            conn.send({
              type: 'roomUrl',
              url: this.roomUrl,
              forceRedirect: true // Force redirect for episode changes
            });
          } catch (e) {
            console.error('CurryParty: Error broadcasting room URL:', e);
          }
        }
      });
    },

    getUserId() {
      chrome.runtime.sendMessage({ action: 'getUserId' }, (response) => {
        this.userId = response.userId;
      });
    },

    detectSite() {
      const url = window.location.href;
      if (url.includes('netflix.com')) return 'netflix';
      if (url.includes('hotstar.com')) return 'hotstar';
      if (url.includes('primevideo.com')) return 'primevideo';
      if (url.includes('youtube.com/watch')) return 'youtube';
      if (url.includes('disneyplus.com')) return 'disney';
      if (url.includes('hulu.com/watch')) return 'hulu';
      if (url.includes('hbomax.com') || url.includes('max.com')) return 'hbomax';
      if (url.includes('animepahe.ru')) return 'animepahe';
      if (url.includes('crunchyroll.com')) return 'crunchyroll';

      // If there's at least one <video>, treat as generic
      if (document.querySelector('video')) {
        console.log('CurryParty: Found a <video> on an unsupported site, trying generic approach');
        return 'generic';
      }
      return null;
    },

    setupVideoObserver() {
      const observer = new MutationObserver(() => {
        if (this.videoElement && this.videoElement.parentNode) {
          // Already have a valid video
          if (this.DEBUG_MODE) {
            console.log('CurryParty: DOM changed, but we already have a video');
          }
          return;
        }
        // Attempt to find a video
        const foundVideo = this.findVideoElement();
        if (foundVideo) {
          console.log('CurryParty: Video element found by observer, setting up listeners');
          this.setupVideoListeners();
        }
      });

      // Start observing
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        // Fallback
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      console.log('CurryParty: Video observer setup complete');
    },

    tryFindVideoEveryInterval(retries, intervalMs) {
      const attempt = () => {
        const found = this.findVideoElement();
        if (found) {
          console.log('CurryParty: Found video via interval-based search');
          this.setupVideoListeners();
        } else if (retries > 1) {
          setTimeout(attempt, intervalMs);
          retries--;
        } else {
          console.log(`ERR:: CurryParty: Failed to find video after ${12} attempts over ~60s`);
        }
      };
      attempt();
    },

    findVideoElement() {
      console.log('CurryParty: Searching for video on site:', this.site);
      let videos = document.querySelectorAll('video');
      if (videos.length === 0) return false;

      // If this.site is Netflix/Hotstar, etc., you could do specialized queries here.
      // For brevity, we just take the first <video> that seems valid.
      for (const vid of videos) {
        // If it has a source or is somewhat loaded, pick it
        if (vid.readyState >= 1 || vid.src) {
          this.videoElement = vid;
          console.log('CurryParty: Picked a video element:', vid);
          this.setupVideoElementMonitor();
          return true;
        }
      }
      return false;
    },

    setupVideoElementMonitor() {
      if (window._videoElementMonitorSet) return;
      window._videoElementMonitorSet = true;
      setInterval(() => {
        if (!this.videoElement || !document.body.contains(this.videoElement)) {
          console.log('CurryParty: Video element removed from DOM, re-finding...');
          this.videoElement = null;
          this.findVideoElement();
          if (this.videoElement) {
            this.setupVideoListeners();
          }
        }
      }, 2000);
    },

    setupVideoListeners() {
      // Always attach native <video> listeners, even for Netflix
      if (!this.videoElement) {
        console.log('CurryParty: setupVideoListeners called with no video element');
        return;
      }
      this.videoElement.removeEventListener('play', this.handlePlayEvent.bind(this));
      this.videoElement.removeEventListener('pause', this.handlePauseEvent.bind(this));
      this.videoElement.removeEventListener('seeked', this.handleSeekEvent.bind(this));

      this.videoElement.addEventListener('play', this.handlePlayEvent.bind(this));
      this.videoElement.addEventListener('pause', this.handlePauseEvent.bind(this));
      this.videoElement.addEventListener('seeked', this.handleSeekEvent.bind(this));

      // this.startPeriodicSync();
      console.log('CurryParty: Video listeners set up');
    },

    updateLivenessIndicator() {
      if (!this.statusContainer || !this.statusIndicator) return;
      
      const now = Date.now();
      const isLive = now - this.lastVideoEventResponseTimestamp < 4000;
      
      if (this.currentRoomId) {
        if (isLive) {
          this.lastVideoEventResponseTimestamp = now;
          this.statusIndicator.style.backgroundColor = '#1E88E5'; // Blue for live activity
        } else {
          this.statusIndicator.style.backgroundColor = '#4CAF50'; // Green for connected
        }
        this.statusContainer.style.display = 'flex';
      } else {
        this.statusIndicator.style.backgroundColor = '#F44336'; // Red for disconnected
        this.statusContainer.style.display = 'none';
      }
    },

    handlePlayEvent() {
      console.log(`CurryParty: handlePlayEvent triggered (remotePlay=${this.remotePlay}) (syncEnabled=${this.syncEnabled})`);
      if (!this.syncEnabled) return;
      if (this.remotePlay) {
        this.remotePlay = false;
        return;
      }
      setTimeout(() => {
        // Always send the play event so peers sync
        if (this.videoElement && !this.videoElement.paused) {
          this.sendVideoEvent('play', { currentTime: this.videoElement.currentTime });
        }
      }, 100);
    },

    handlePauseEvent() {
      console.log(`CurryParty: handlePauseEvent triggered (remotePause=${this.remotePause}) (syncEnabled=${this.syncEnabled})`);
      if (!this.syncEnabled) return;
      if (this.remotePause) {
        this.remotePause = false;
        return;
      }
      setTimeout(() => {
        if (this.videoElement && this.videoElement.paused) {
          this.sendVideoEvent('pause', { currentTime: this.videoElement.currentTime });
        }
      }, 100);
    },

    handleSeekEvent() {
      console.log(`CurryParty: handleSeekEvent triggered (remoteSeek=${this.remoteSeek}) (syncEnabled=${this.syncEnabled})`);
      if (!this.syncEnabled) return;
      if (this.remoteSeek) {
        this.remoteSeek = false;
        return;
      }
      // Debounce if needed
      if (this._seekTimeout) clearTimeout(this._seekTimeout);
      this._seekTimeout = setTimeout(() => {
        if (this.videoElement) {
          this.sendVideoEvent('seek', { currentTime: this.videoElement.currentTime });
          // Also re-send pause/play after a small delay
          setTimeout(() => {
            if (!this.videoElement) return;
            this.sendVideoEvent(
              this.videoElement.paused ? 'pause' : 'play',
              { currentTime: this.videoElement.currentTime }
            );
          }, 200);
        }
      }, 100);
    },

    startPeriodicSync() {
      // TODO: Not sure if it works!
      if (this.syncInterval) clearInterval(this.syncInterval);
      this.syncInterval = setInterval(() => {
        if (!this.syncEnabled || !this.videoElement) return;
        const currentTime = this.videoElement.currentTime;
        const currentState = this.videoElement.paused ? 'paused' : 'playing';
        if (Math.abs(currentTime - this.lastSentTime) > 3 || currentState !== this.lastSentState) {
          this.sendVideoEvent('sync', { currentTime, state: currentState });
          this.lastSentTime = currentTime;
          this.lastSentState = currentState;
        }
      }, 3000);
    },

    sendVideoEvent(eventType, data) {
      if (!this.syncEnabled) return;
      const now = Date.now();
      if (this.lastEventType === eventType && now - this.lastEventTimestamp < 700) {
        console.log(`CurryParty: Debouncing duplicate ${eventType} event`);
        return;
      }
      this.lastEventTimestamp = now;
      this.lastEventType = eventType;

      if (!this.peer) {
        console.log('CurryParty: Peer not ready, cannot send event');
        return;
      }
      // If host, broadcast. Otherwise, send to host if connection is open.
      if (this.isHost) {
        this.broadcastVideoEvent(eventType, data);
      } else {
        const hostConn = this.connections[0];
        if (hostConn && hostConn.open) {
          hostConn.send({
            type: 'videoEvent',
            userId: this.userId,
            site: this.site,
            event: { eventType, data, timestamp: Date.now() }
          });
        } else {
          console.log('CurryParty: No open host connection, attempting reconnect...');
          this.scheduleReconnect();
        }
      }
    },

    broadcastVideoEvent(eventType, data) {
      if (!this.connections || this.connections.length === 0) return;
      this.connections.forEach(conn => {
        if (conn && conn.open) {
          try {
            conn.send({
              type: 'videoEvent',
              userId: this.userId,
              site: this.site,
              event: { eventType, data, timestamp: Date.now() }
            });
          } catch (e) {
            console.error('CurryParty: Broadcast error:', e);
          }
        }
      });
    },

    // =========================================
    // Room / Peer management (shortened version)
    // =========================================
    checkCurrentRoom() {
      chrome.runtime.sendMessage({ action: 'getCurrentRoom' }, (response) => {
        if (response && response.roomId) {
          this.currentRoomId = response.roomId;
          this.isHost = response.isHost;
          this.roomUrl = response.roomUrl;
          this.syncEnabled = true;
          console.log('CurryParty: Already in a room:', this.currentRoomId, 'for URL:', this.roomUrl);
          
          // Check if current URL matches room URL
          if (this.roomUrl) {
            const currentBaseUrl = this.getBaseUrl(this.currentUrl);
            if (currentBaseUrl !== this.roomUrl && !this.isHost) {
              console.log('CurryParty: Current URL does not match room URL, offering redirect');
              this.offerRedirectToRoomUrl();
            }
          }
          
          if (!this.peerInitialized) {
            this.peerInitialized = true;
            this.initializePeerConnection();
          }
        } else {
          console.log('CurryParty: Not in any room');
        }
      });
    },

    startLivenessCheck() {
      if (this.livenessCheckInterval) clearInterval(this.livenessCheckInterval);
      
      this.livenessCheckInterval = setInterval(() => {
        // this.updateLivenessIndicator();
        this.lastVideoEventResponseTimestamp = Date.now();
        
        // Send ping to all connections periodically
        if (this.connections && this.connections.length > 0) {
          this.connections.forEach(conn => {
            if (conn && conn.open) {
              try {
                conn.send({ type: 'ping', timestamp: Date.now() });
              } catch (e) {
                console.error('CurryParty: Ping error:', e);
              }
            }
          });
          
          // Regularly update participant count (every 5 seconds)
          if (Date.now() % 5000 < 1000) {
            this.updateParticipantCount();
          }
        }

        if (this.lastPongTimestamp && Date.now() - this.lastPongTimestamp > 4000) {
          console.log('CurryParty: No pong received in 4 seconds, liveness ended...');
          this.statusIndicator.style.backgroundColor = '#4CAF50';
        }
      }, 1000); // Check every second
    },    

    initializePeerConnection() {
      // Some trimmed logic: create a Peer instance and handle open/error/connection
      if (typeof Peer === 'undefined') {
        console.error('CurryParty: PeerJS not loaded!');
        return;
      }
      this.cleanupPeerConnection(); // ensure no duplicates

      this.peerInitAttempts++;
      if (this.peerInitAttempts > 5) {
        this.updateUIStatus('Too many attempts. Refresh to try again.');
        return;
      }

      // Example: use a single ID if host, or random for client
      if (this.isHost) {
        const hostId = `curryparty-host-${this.currentRoomId}`;
        this.peer = new Peer(hostId, { 
          config: {
            'iceServers': CurryPartyConfig.iceServers,
          },
          debug: 2,
        });
        this.setupHostPeerHandlers(this.peer, hostId);
      } else {
        const peerId = `curryparty-peer-r${Math.random().toString(36).substr(2, 6)}`;
        this.peer = new Peer(peerId, { 
          config: {
            'iceServers': CurryPartyConfig.iceServers,
          },
          debug: 2 
        });
        this.setupClientPeerHandlers(this.peer);
      }
      this.startLivenessCheck();
    },

    setupHostPeerHandlers(peerObj, hostId) {
      peerObj.on('open', (id) => {
        console.log('CurryParty: Host peer open with ID:', id);
        this.startConnectionHealthCheck();
        this.updateUIStatus('Connected (Host)');
      });
      peerObj.on('connection', (conn) => {
        // Host receives a new connection
        this.handleNewConnection(conn);
      });
      peerObj.on('disconnected', () => {
        this.scheduleReconnect();
      });
      peerObj.on('error', (err) => {
        console.error('CurryParty: Host peer error:', err);
        this.scheduleReconnect();
      });
    },

    setupClientPeerHandlers(peerObj) {
      peerObj.on('open', (id) => {
        console.log('CurryParty: Client peer open with ID:', id);
        // Attempt to connect to the host
        const hostId = `curryparty-host-${this.currentRoomId}`; // Simplified
        console.log('CurryParty: Connecting to host:', hostId);
        let conn = peerObj.connect(hostId);
        
        conn.on('open', () => {
          console.log('CurryParty: Connected to host:', hostId);
          this.handleNewConnection(conn);
          console.log('CurryParty: Requesting sync from host...');
          
          // Request the current state from the host
          conn.send({ type: 'syncRequest' });
          
          // Also explicitly request the room URL from host
          conn.send({ type: 'roomUrlRequest' });
        });
        
        conn.on('error', (err) => {
          console.error('CurryParty: Connection to host error:', err);
          this.scheduleReconnect();
        });
        
        this.startConnectionHealthCheck();
        this.updateUIStatus('Connected');
      });
      
      peerObj.on('disconnected', () => {
        console.log('CurryParty: Client peer disconnected');
        this.scheduleReconnect();
      });
      
      peerObj.on('error', (err) => {
        console.error('CurryParty: Client peer error:', err);
        this.scheduleReconnect();
      });
    },

    handleNewConnection(conn) {
      console.log('CurryParty: New connection from peer:', conn.peer);
      this.connections.push(conn);

      // Immediately track the peer in peerRegistry
      this.peerRegistry[conn.peer] = {
        id: conn.peer,
        active: true,
        lastSeen: Date.now()
      };
      
      // Update participant count
      this.updateParticipantCount();

      conn.on('data', (data) => {
        this.handleIncomingData(data, conn);
        // Update lastSeen each time we get data
        this.peerRegistry[conn.peer].lastSeen = Date.now();
      });
      conn.on('close', () => {
        console.log('CurryParty: Connection closed:', conn.peer);
        this.connections = this.connections.filter(c => c.peer !== conn.peer);

        // Mark peer inactive
        if (this.peerRegistry[conn.peer]) {
          this.peerRegistry[conn.peer].active = false;
        }
        
        // Update participant count
        this.updateParticipantCount();
      });
    },

    handleIncomingData(data, conn) {
      if (!data || !data.type) return;

      if (data.type === 'syncRequest') {
        // If I'm the host, respond with current playback status
        if (this.isHost && this.videoElement) {
          const currentTime = this.videoElement.currentTime;
          const currentState = this.videoElement.paused ? 'paused' : 'playing';
          console.log('CurryParty: Received syncRequest - sending syncResponse');
          conn.send({
            type: 'syncResponse',
            data: { currentTime, state: currentState }
          });
          
          // Also send room URL with sync response
          if (this.roomUrl) {
            console.log('CurryParty: Sending room URL with sync response:', this.roomUrl);
            conn.send({
              type: 'roomUrl',
              url: this.roomUrl
            });
          }
        }
        return;
      } else if (data.type === 'roomUrlRequest') {
        // Client specifically requested the room URL
        if (this.isHost && this.roomUrl) {
          console.log('CurryParty: Received explicit roomUrlRequest, sending:', this.roomUrl);
          conn.send({
            type: 'roomUrl',
            url: this.roomUrl,
            forceRedirect: true // Force redirect when explicitly requested
          });
        }
        return;
      } else if (data.type === 'syncResponse') {
        // I'm the client: sync my video to the host
        const { currentTime, state } = data.data;
        console.log(`CurryParty: Received syncResponse => time=${currentTime}, state=${state}`);
        this.handleVideoCommand('sync', { currentTime, state });
        return;
      } else if (data.type === 'roomUrl') {
        // Received room URL from host
        console.log('CurryParty: Received room URL from host:', data.url);
        this.roomUrl = data.url;
        
        // Check if we need to redirect
        const currentBaseUrl = this.getBaseUrl(this.currentUrl);
        
        if (currentBaseUrl !== this.roomUrl) {
          // Check if the current URL and room URL are on the same domain
          const sameDomain = this.isSameDomain(this.currentUrl, this.roomUrl);
          console.log('CurryParty: URL mismatch detected. Same domain:', sameDomain, ', Force redirect:', data.forceRedirect);
          
          if (sameDomain && data.forceRedirect) {
            // Force redirect - host moved to a new page on the same domain
            console.log('CurryParty: Host moved to a new page, forcing redirect to:', this.roomUrl);
            this.showNotification('Host moved to a new page. Redirecting...');
            setTimeout(() => {
              console.log('CurryParty: Executing redirect to:', this.roomUrl);
              window.location.href = this.roomUrl;
            }, 1500);
          } else {
            // Just offer a redirect for different domains or non-forced updates
            console.log('CurryParty: Offering redirect to room URL');
            this.offerRedirectToRoomUrl();
          }
        } else {
          console.log('CurryParty: Current URL already matches room URL, no redirect needed');
        }
        return;
      }

      if (data.type === 'videoEvent') {
        const evt = data.event || {};
        
        // Skip events that came from the same user on a different site
        // This prevents cross-site syncing (e.g., Netflix syncing with YouTube) on the same machine
        const senderUserId = data.userId;
        const senderSite = data.site;
        
        if (senderUserId && senderUserId === this.userId) {
          // Allow same-site sync (for multiple tabs on same service), 
          // but prevent different-site sync from same user
          if (senderSite && senderSite !== this.site) {
            console.log(`CurryParty: Ignoring event from same user's different site (${senderSite})`);
            return;
          }
        }
        
        this.handleVideoCommand(evt.eventType, evt.data);
        conn.send({ type: 'videoEventResponse', "data": "OK" });
        // If host, relay to others
        if (this.isHost) {
          this.connections.forEach(c => {
            if (c !== conn && c.open) {
              c.send(data);
            }
          });
        }
      }

      if(data.type === 'ping') {
        conn.send({ type: 'pong', timestamp: Date.now() });
      }

      if(data.type === 'pong') {
        console.log('CurryParty: Received pong:', data.timestamp);
        this.lastPongTimestamp = Date.now()
        // Update liveness timestamp on pong as well
        // this.lastVideoEventResponseTimestamp = Date.now();
        this.updateLivenessIndicator();
      }

      if(data.type === 'videoEventResponse') {
        console.log('CurryParty: Received videoEventResponse:', data.data);
        // this.lastVideoEventResponseTimestamp = Date.now();
        // this.updateLivenessIndicator();
      }
      // ... handle other data types (join, removePeer, etc.)
    },

    handleVideoCommand(eventType, data) {
      if (!this.syncEnabled) return;

      // Special handling for Netflix
      if (this.site === 'netflix') {
        if (!this.videoElement) {
          console.warn('CurryParty: No video element available');
          return;
        }
        try {
          switch (eventType) {
            case 'play':
              if (this.videoElement.paused) {
                console.log('CurryParty: Using Netflix player().play()');
                // Use Netflix's internal play
                try {
                  window.postMessage({ type: 'NETFLIX_CONTROL', action: 'PLAY' }, '*');
                } catch (e) {
                  console.warn('CurryParty: Netflix player play() failed:', e);
                  this.showNotification('Autoplay blocked. Click play to sync.');
                }
              }
              break;
            case 'pause':
              if (!this.videoElement.paused) {
                console.log('CurryParty: Using Netflix player().pause()');
                // Use Netflix's internal play
                try {
                  window.postMessage({ type: 'NETFLIX_CONTROL', action: 'PAUSE' }, '*');
                } catch (e) {
                  console.warn('CurryParty: Netflix player pause() failed:', e);
                }
              }
              break;
            case 'seek':
              if (data.currentTime !== undefined) {
                // Netflix expects milliseconds
                // this.videoElement.currentTime = data.currentTime;
                  console.log('CurryParty: Using Netflix player().seek()');
                  // Use Netflix's internal play
                  try {
                    window.postMessage({ type: 'NETFLIX_CONTROL', action: 'SEEK', value: data.currentTime*1000 }, '*');
                  } catch (e) {
                    console.warn('CurryParty: Netflix player seek() failed:', e);
                  }
              }
              break;
            case 'sync':
              console.log('CurryParty: Received sync:', {eventType, data});
              if (data.currentTime !== undefined) {
                const currentPosMs = this.videoElement.currentTime * 1000;
                const diff = Math.abs(currentPosMs - data.currentTime * 1000);
                if (diff > 2) {
                  console.log('CurryParty: Syncing to', currentPosMs, 'from', data.currentTime, 'diff', diff);
                  // this.videoElement.currentTime = data.currentTime / 1000;
                  console.log('CurryParty: Using Netflix player().seek()');
                  // Use Netflix's internal play
                  try {
                    window.postMessage({ type: 'NETFLIX_CONTROL', action: 'SEEK', value: data.currentTime*1000 }, '*');
                  } catch (e) {
                    console.warn('CurryParty: Netflix player seek() failed:', e);
                  }
                }
              }
              // If host is playing, ensure we are playing
              if (data.state === 'playing' && this.videoElement.paused) {
                console.log('CurryParty: Using Netflix player().play()');
                // Use Netflix's internal play
                try {
                  window.postMessage({ type: 'NETFLIX_CONTROL', action: 'PLAY' }, '*');
                } catch (e) {
                  console.warn('CurryParty: Netflix player play() failed:', e);
                  this.showNotification('Autoplay blocked. Click play to sync.');
                }
              } else if (data.state === 'paused' && !this.videoElement.paused) {
                this.videoElement.pause();
                console.log('CurryParty: Using Netflix player().pause()');
                // Use Netflix's internal play
                try {
                  window.postMessage({ type: 'NETFLIX_CONTROL', action: 'PAUSE' }, '*');
                } catch (e) {
                  console.warn('CurryParty: Netflix player pause() failed:', e);
                }
              }
              break;
            default:
              console.log('CurryParty: Unknown Netflix command:', eventType);
          }
        } catch (e) {
          console.error('CurryParty: Error handling Netflix command:', e);
        }
        return;
      }

      // ====== Fallback for non-Netflix sites ======
      if (!this.videoElement) return;
      try {
        switch (eventType) {
          case 'play':
            if (this.videoElement.paused) {
              this.remotePlay = true;
              if (data.currentTime !== undefined) {
                this.remoteSeek = true;
                this.videoElement.currentTime = data.currentTime;
              }
              this.videoElement.play().catch(e => {
                console.error('Error playing:', e);
                this.showNotification('Autoplay blocked. Click play to sync.');
              });
            }
            break;
          case 'pause':
            if (!this.videoElement.paused) {
              this.remotePause = true;
              if (data.currentTime !== undefined) {
                this.remoteSeek = true;
                this.videoElement.currentTime = data.currentTime;
              }
              this.videoElement.pause();
            }
            break;
          case 'seek':
            if (data.currentTime !== undefined) {
              const diff = Math.abs(this.videoElement.currentTime - data.currentTime);
              if (diff > 0.5) {
                this.remoteSeek = true;
                this.videoElement.currentTime = data.currentTime;
              }
            }
            break;
          case 'sync':
            const diff = Math.abs(this.videoElement.currentTime - data.currentTime);
            if (diff > 2) {
              this.remoteSeek = true;
              this.videoElement.currentTime = data.currentTime;
            }
            if (data.state === 'playing' && this.videoElement.paused) {
              this.remotePlay = true;
              this.videoElement.play().catch(() => {
                this.showNotification('Autoplay blocked. Click play to sync.');
              });
            } else if (data.state === 'paused' && !this.videoElement.paused) {
              this.remotePause = true;
              this.videoElement.pause();
            }
            break;
          default:
            console.log('CurryParty: Unknown command:', eventType);
        }
      } catch (e) {
        console.error('CurryParty: Error handling video command:', e);
      }
    },

    scheduleReconnect() {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts++;
      if (this.reconnectAttempts > 10) {
        this.updateUIStatus('Connection lost. Please refresh.');
        return;
      }
      const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 30000);
      this.reconnectTimer = setTimeout(() => {
        if (this.currentRoomId) {
          this.peerInitialized = false;
          this.cleanupPeerConnection();
          this.initializePeerConnection();
          this.updateUIStatus(`Reconnecting (attempt ${this.reconnectAttempts})`);
        }
      }, delay);
    },

    startConnectionHealthCheck() {
      if (this.connectionHealthCheck) clearInterval(this.connectionHealthCheck);
      this.connectionHealthCheck = setInterval(() => {
        if (!this.peer || this.peer.disconnected) {
          this.scheduleReconnect();
        } else {
          console.log('CurryParty: Connection to peerjs is healthy');
        }
      }, 2000);
    },

    cleanupPeerConnection() {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.connectionHealthCheck) clearInterval(this.connectionHealthCheck);
      if (this.syncInterval) clearInterval(this.syncInterval);
      if (this.livenessCheckInterval) clearInterval(this.livenessCheckInterval);

      this.connections.forEach(conn => {
        if (conn && conn.open) {
          conn.send({ type: 'leave' });
          conn.close();
        }
      });
      this.connections = [];
      if (this.peer) {
        this.peer.destroy();
      }
      this.peer = null;
    },

    // ===========================
    // UI and Messaging
    // ===========================
    addUI() {
      const container = document.createElement('div');
      container.id = 'curry-party-status';
      container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0,0,0,0.7);
        color: #fff;
        padding: 8px 12px;
        border-radius: 5px;
        z-index: 9999;
        display: none;
        align-items: center;
      `;
      const indicator = document.createElement('div');
      indicator.style.cssText = `
        width: 10px; height: 10px; border-radius: 50%;
        background-color: #F44336; margin-right: 8px;
      `;
      const textSpan = document.createElement('span');
      textSpan.textContent = 'Not connected';

      container.appendChild(indicator);
      container.appendChild(textSpan);
      document.body.appendChild(container);

      this.statusContainer = container;
      this.statusIndicator = indicator;
      this.statusText = textSpan;

      // Hover effect
      container.addEventListener('mouseenter', () => (container.style.opacity = '1'));
      container.addEventListener('mouseleave', () => (container.style.opacity = '0.7'));
      container.style.opacity = '0.7';

      this.updateUIStatus();
    },

    updateParticipantCount() {
      // Count active connections plus self
      const activeConnections = this.isHost 
        ? Object.values(this.peerRegistry).filter(p => p.active).length 
        : this.connections.filter(c => c.open).length;
      
      // Include self in the count (always at least 1)
      this.participantCount = 1 + activeConnections;
      
      // Update UI
      this.updateUIStatus();
      
      // Notify background script to update all instances
      chrome.runtime.sendMessage({
        action: 'updateParticipantCount',
        count: this.participantCount
      });
    },
    
    updateUIStatus(message) {
      if (!this.statusContainer || !this.statusIndicator || !this.statusText) return;
      if (message) {
        this.statusText.textContent = message;
      } else if (this.currentRoomId) {
        const label = this.isHost ? 'Connected (Host)' : 'Connected';
        let statusText = `${label}: ${this.currentRoomId} (${this.participantCount} in room)`;
        
        // Check for URL compatibility
        if (this.roomUrl) {
          const currentBaseUrl = this.getBaseUrl(this.currentUrl);
          if (currentBaseUrl !== this.roomUrl) {
            statusText += ' ⚠️ URL mismatch';
          }
        }
        
        this.statusText.textContent = statusText;
        this.updateLivenessIndicator();
        // this.statusIndicator.style.backgroundColor = '#4CAF50';
        // this.statusContainer.style.display = 'flex';
      } else {
        this.statusText.textContent = 'Not connected';
        this.statusIndicator.style.backgroundColor = '#F44336';
        this.statusContainer.style.display = 'none';
      }
    },

    showNotification(msg, duration = 3000) {
      const notif = document.createElement('div');
      notif.style.cssText = `
        position: fixed; top: 70px; right: 20px;
        background-color: rgba(0,0,0,0.8); color: #fff;
        padding: 10px 15px; border-radius: 5px; z-index: 10000;
        font-family: Arial, sans-serif; font-size: 14px;
      `;
      notif.textContent = msg;
      document.body.appendChild(notif);

      setTimeout(() => {
        notif.style.opacity = '0';
        notif.style.transition = 'opacity 0.5s';
        setTimeout(() => {
          if (notif.parentNode) {
            notif.parentNode.removeChild(notif);
          }
        }, 500);
      }, duration);
    },

    // Add a method to remove a peer
    removePeer(peerId) {
      if (!peerId) return;
      console.log(`CurryParty: removePeer called for ${peerId}`);

      // Mark as inactive
      if (this.peerRegistry[peerId]) {
        this.peerRegistry[peerId].active = false;
      }

      // Close the peer connection
      const conn = this.connections.find(c => c.peer === peerId);
      if (conn && conn.open) {
        // Pause the peer's video first
        if (this.videoElement) {
          conn.send({
            type: 'videoEvent',
            event: {
              eventType: 'pause',
              data: { currentTime: this.videoElement.currentTime }
            }
          });
        }
        // Let them know they have been kicked
        conn.send({ type: 'adminCommand', command: 'kick' });
        conn.send({ type: 'leave' });
        conn.close();
      }
      this.connections = this.connections.filter(c => c.peer !== peerId);
      
      // Update participant count after removing the peer
      this.updateParticipantCount();
      
      console.log(`CurryParty: removePeer complete for ${peerId}`);
    },
  };

  // ======================================================
  // DOM ready logic
  // ======================================================
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => CurryPartyManager.safeInitialize(), 1000);
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => CurryPartyManager.safeInitialize(), 1500);
  }

  // ======================================================
  // Message listener for external commands
  // ======================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;
    try {
      switch (message.action) {
        case 'ping':
          sendResponse({ success: true });
          return true;
        case 'videoCommand':
          CurryPartyManager.handleVideoCommand(message.eventType, message.data);
          sendResponse({ success: true });
          return true;
        case 'roomUpdate':
          const wasInRoom = !!CurryPartyManager.currentRoomId;
          CurryPartyManager.currentRoomId = message.roomId;
          CurryPartyManager.isHost = message.isHost;
          CurryPartyManager.roomUrl = message.roomUrl;
          CurryPartyManager.syncEnabled = !!message.roomId;

          if (CurryPartyManager.currentRoomId && (!wasInRoom || !CurryPartyManager.peerInitialized)) {
            CurryPartyManager.peerInitialized = true;
            CurryPartyManager.initializePeerConnection();
            
            // Check if current URL matches room URL (for non-hosts)
            if (!CurryPartyManager.isHost && CurryPartyManager.roomUrl) {
              const currentBaseUrl = CurryPartyManager.getBaseUrl(window.location.href);
              if (currentBaseUrl !== CurryPartyManager.roomUrl) {
                console.log('CurryParty: Current URL does not match room URL, offering redirect');
                CurryPartyManager.offerRedirectToRoomUrl();
              }
            }
          } else if (!CurryPartyManager.currentRoomId) {
            // room left
            CurryPartyManager.cleanupPeerConnection();
            CurryPartyManager.roomUrl = null;
          }
          // Reset participant count when room status changes
          CurryPartyManager.participantCount = 1;
          CurryPartyManager.updateParticipantCount();
          CurryPartyManager.updateUIStatus();
          sendResponse({ success: true });
          return true;
        case 'getPeerRegistry':
          console.log('CurryParty: Received getPeerRegistry request');
          sendResponse({ peerRegistry: CurryPartyManager.peerRegistry || {} });
          return true;
        case 'removePeer':
          console.log('CurryParty: Received removePeer request for peerId=', message.peerId);
          CurryPartyManager.removePeer(message.peerId);
          sendResponse({ success: true });
          return true;
        // ... handle more cases like removePeer, getPeerRegistry, etc.
      }
    } catch (err) {
      console.error('CurryParty: Error in onMessage:', err);
      sendResponse({ success: false, error: err.message });
      return true;
    }
    return false;
  });
})();