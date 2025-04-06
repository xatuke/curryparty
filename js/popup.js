document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // ====== UI Elements ======
  const createRoomBtn = document.getElementById('create-room-btn');
  const joinRoomBtn = document.getElementById('join-room-btn');
  const leaveRoomBtn = document.getElementById('leave-room-btn');
  const copyRoomIdBtn = document.getElementById('copy-room-id');

  const roomIdInput = document.getElementById('room-id');
  const joinRoomIdInput = document.getElementById('join-room-id');

  const roomContainer = document.getElementById('room-container');
  const roomControls = document.getElementById('room-controls');
  const roomIdContainer = document.getElementById('room-id-container');
  const currentRoomSpan = document.getElementById('current-room');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status');
  const participantCount = document.getElementById('participant-count');
  const peerListSection = document.getElementById('peer-list-section');
  const peerList = document.getElementById('peer-list');

  let peerRegistry = {};
  let isHost = false;

  // ====== Event Listeners ======
  createRoomBtn.addEventListener('click', onCreateRoom);
  joinRoomBtn.addEventListener('click', onJoinRoom);
  leaveRoomBtn.addEventListener('click', onLeaveRoom);
  copyRoomIdBtn.addEventListener('click', onCopyRoomId);

  // ====== Initialization ======
  chrome.storage.local.get(['roomId', 'isHost'], (result) => {
    if (result.roomId) {
      isHost = !!result.isHost;
      showRoomControls(result.roomId, isHost);
      updateStatus(isHost ? 'Connected (Host)' : 'Connected', true);

      if (isHost) {
        setupPeerRegistryListener();
      }
    }
  });

  // Listen for participant count or peer registry updates
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'updateParticipantCount':
        participantCount.textContent = request.count;
        break;
      case 'connectionStatus':
        updateStatus(request.status, request.connected);
        break;
      case 'updatePeerRegistry':
        if (isHost) {
          peerRegistry = request.peerRegistry || {};
          updatePeerList();
        }
        break;
    }
  });

  // ====== Handlers ======
  function onCreateRoom() {
    const roomId = generateRoomId();
    
    // Get the URL from the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length) {
        alert('Could not access current tab. Try again.');
        return;
      }
      
      const currentUrl = tabs[0].url;
      console.log('Creating room with URL:', currentUrl);
      
      chrome.runtime.sendMessage({ 
        action: 'createRoom', 
        roomId,
        url: currentUrl 
      }, (response) => {
        if (response && response.success) {
          isHost = true;
          const uniqueRoomId = response.roomId || roomId;
          roomIdInput.value = uniqueRoomId;
          roomIdContainer.classList.remove('hidden');

          showRoomControls(uniqueRoomId, true);
          updateStatus('Connected (Host)', true);
          setupPeerRegistryListener();
        }
      });
    });
  }

  function onJoinRoom() {
    const roomId = joinRoomIdInput.value.trim();
    if (!roomId) {
      alert('Please enter a valid Room ID');
      return;
    }
    joinRoomBtn.disabled = true;
    joinRoomBtn.textContent = 'Connecting...';

    chrome.storage.local.remove([
      'lastSuccessfulHostId', 'lastRejectedHostId',
      'lastHostId', 'hostPeerId'
    ], () => {
      chrome.runtime.sendMessage({ action: 'joinRoom', roomId }, (response) => {
        joinRoomBtn.disabled = false;
        joinRoomBtn.textContent = 'Join Room';

        if (response && response.success) {
          isHost = false;
          chrome.storage.local.set({
            roomId, isHost: false, joinedAt: Date.now()
          });

          showRoomControls(roomId, false);
          updateStatus('Connected', true);
        } else {
          alert('Failed to join room. Check the ID and try again.');
        }
      });
    });
  }

  function onLeaveRoom() {
    chrome.storage.local.get(['roomId'], (result) => {
      if (!result.roomId) return;
      chrome.runtime.sendMessage({ action: 'leaveRoom', roomId: result.roomId });
      chrome.storage.local.remove(['roomId', 'isHost']);
      peerRegistry = {};
      isHost = false;

      hideRoomControls();
      updateStatus('Not connected', false);
    });
  }

  function onCopyRoomId() {
    roomIdInput.select();
    document.execCommand('copy');
    copyRoomIdBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyRoomIdBtn.textContent = 'Copy';
    }, 2000);
  }

  // ====== UI Updates ======
  function showRoomControls(roomId, hostStatus) {
    roomContainer.classList.add('hidden');
    roomControls.classList.remove('hidden');
    currentRoomSpan.textContent = roomId;

    if (hostStatus) {
      roomIdInput.value = roomId;
      roomIdContainer.classList.remove('hidden');
      if (peerListSection) {
        peerListSection.classList.remove('hidden');
      }
    } else {
      if (peerListSection) {
        peerListSection.classList.add('hidden');
      }
    }
  }

  function hideRoomControls() {
    roomContainer.classList.remove('hidden');
    roomControls.classList.add('hidden');
    roomIdContainer.classList.add('hidden');
    if (peerListSection) peerListSection.classList.add('hidden');
  }

  function updateStatus(text, connected) {
    statusText.textContent = text;
    if (connected) {
      statusIndicator.classList.remove('offline');
      statusIndicator.classList.add('online');
    } else {
      statusIndicator.classList.remove('online');
      statusIndicator.classList.add('offline');
    }
  }

  // ====== Peer Registry (Host Only) ======
  function setupPeerRegistryListener() {
    // Get the active tab & request registry
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        const activeTabId = tabs[0].id;
        chrome.tabs.sendMessage(activeTabId, { action: 'getPeerRegistry' }, (resp) => {
          if (resp && resp.peerRegistry) {
            peerRegistry = resp.peerRegistry;
            updatePeerList();
          }
        });
      }
    });
    if (peerListSection) {
      peerListSection.classList.remove('hidden');
    }
  }

  function updatePeerList() {
    if (!peerList || !isHost) return;
    peerList.innerHTML = '';

    const peers = Object.values(peerRegistry || {});
    if (peers.length === 0) {
      const noPeersMsg = document.createElement('p');
      noPeersMsg.className = 'no-peers-message';
      noPeersMsg.textContent = 'No other peers connected';
      peerList.appendChild(noPeersMsg);
      return;
    }

    // Sort by lastSeen desc
    peers.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    peers.forEach(peer => {
      const peerItem = document.createElement('div');
      peerItem.className = 'peer-item';

      const peerInfo = document.createElement('div');
      peerInfo.className = 'peer-info';

      const statusDot = document.createElement('span');
      statusDot.className = `peer-status ${peer.active ? 'active' : 'inactive'}`;
      peerInfo.appendChild(statusDot);

      const shortId = (peer.id || '').split('-').pop().substring(0, 8) + '...';
      const peerIdElem = document.createElement('span');
      peerIdElem.className = 'peer-id';
      peerIdElem.textContent = shortId;
      peerInfo.appendChild(peerIdElem);

      peerItem.appendChild(peerInfo);

      if (peer.active) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-peer-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.dataset.peerId = peer.id;

        removeBtn.addEventListener('click', () => removePeer(peer.id));
        peerItem.appendChild(removeBtn);
      }
      peerList.appendChild(peerItem);
    });
  }

  function removePeer(peerId) {
    if (!isHost || !peerId) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length) return;
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, {
        action: 'removePeer',
        peerId: peerId
      }, (response) => {
        if (response && response.success) {
          if (peerRegistry[peerId]) {
            peerRegistry[peerId].active = false;
            updatePeerList();
          }
        }
      });
    });
  }

  // ====== Helpers ======
  function generateRoomId() {
    return Math.random().toString(36).substring(2, 10);
  }
});