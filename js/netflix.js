window.addEventListener('message', (event) => {
  // Only handle events of the proper type
  if (event.data && event.data.type === 'NETFLIX_CONTROL') {
    // Retrieve the Netflix video player
    const videoPlayer = netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const sessionId = videoPlayer.getAllPlayerSessionIds()[0];
    const player = videoPlayer.getVideoPlayerBySessionId(sessionId);

    // Extract the action and value (if any) from the message
    const { action, value } = event.data;

    switch (action) {
      case 'PLAY':
        player.play();
        break;
      case 'PAUSE':
        player.pause();
        break;
      case 'SEEK':
        // 'value' indicates time in milliseconds/seconds (depending on your logic)
        player.seek(value);
        break;
      default:
        console.log('Unknown action:', action);
    }
  }
});
