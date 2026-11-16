// Loaded before the pinned Navidrome share runtime so it starts with the saved tracks.
(() => {
  const storageKey = 'tree2.vinyl-playlist';
  const lifetime = 15 * 24 * 60 * 60 * 1000;
  const trackId = /^[a-f0-9]{64}\.(?:mp3|wav|m4a|ogg|flac|aac)$/;
  const share = JSON.parse(window.__SHARE_INFO__);
  const openedTrack = share.tracks[0];
  let memory;
  let useMemory = false;
  let player;
  let panelOpen = false;

  function read() {
    let saved;
    try { saved = useMemory ? memory : JSON.parse(localStorage.getItem(storageKey)); }
    catch { saved = memory; }
    const now = Date.now();
    if (!Array.isArray(saved?.tracks) || !Number.isFinite(saved.openedAt) ||
        saved.openedAt > now || now - saved.openedAt >= lifetime) {
      return { openedAt: 0, tracks: [] };
    }
    const unique = new Map();
    for (const track of saved.tracks) {
      if (typeof track?.id === 'string' && trackId.test(track.id) && typeof track.title === 'string' && !unique.has(track.id)) {
        const artist = typeof track.artist === 'string' ? track.artist : '';
        unique.set(track.id, { id: track.id, title: track.title, artist, duration: 0 });
      }
    }
    return { openedAt: saved.openedAt, tracks: [...unique.values()] };
  }

  function write(tracks, openedAt) {
    memory = { tracks, openedAt };
    try { localStorage.setItem(storageKey, JSON.stringify(memory)); useMemory = false; }
    catch { useMemory = true; }
  }

  const saved = read();
  const existing = saved.tracks.findIndex(track => track.id === openedTrack.id);
  if (existing === -1) saved.tracks.push(openedTrack);
  else saved.tracks[existing] = openedTrack;
  write(saved.tracks, Date.now());
  // The original share view starts on its first track. Restore the saved order once mounted.
  share.tracks = [openedTrack, ...saved.tracks.filter(track => track.id !== openedTrack.id)];
  window.__SHARE_INFO__ = JSON.stringify(share);

  const base = JSON.parse(window.__APP_CONFIG__).baseURL + '/share';
  const streamUrl = id => `${base}/s/${id}`;
  const idFromUrl = url => url?.split('/').at(-1);

  function current() {
    if (!player) return openedTrack;
    const id = idFromUrl(player.state.musicSrc);
    return trackId.test(id) ? { id, title: player.state.name } : null;
  }

  function apply(tracks) {
    if (!player) return;
    const previous = player.state.audioLists;
    if (tracks.length === previous.length && tracks.every((track, index) =>
      streamUrl(track.id) === previous[index].musicSrc && track.title === previous[index].name)) return;
    if (!tracks.length) {
      player.resetAudioStatus();
      return;
    }
    const previousIndex = player.getCurrentPlayIndex();
    const active = current();
    const index = tracks.findIndex(track => track.id === active?.id);
    const audioLists = tracks.map(track => ({
      name: track.title,
      singer: track.artist,
      duration: track.duration,
      musicSrc: streamUrl(track.id),
      cover: `${base}/img/${track.id}?size=300&square=true`,
    }));
    const next = player.getPlayInfoOfNewList({ audioLists, quietUpdate: true }).audioLists;
    player.setState({ audioLists: next, playIndex: Math.max(index, 0) }, () => {
      if (index === -1) player.updatePlayIndex(Math.min(Math.max(previousIndex, 0), next.length - 1));
    });
  }

  function touch() {
    const saved = read();
    const active = current();
    if (!saved.openedAt && active) saved.tracks.push({ ...active, duration: 0 });
    write(saved.tracks, Date.now());
    apply(saved.tracks);
  }

  function edit(id, action) {
    const saved = read();
    const index = saved.tracks.findIndex(track => track.id === id);
    if (index === -1) return;
    const nextIndex = index + (action === 'up' ? -1 : 1);
    if (action !== 'remove' && (nextIndex < 0 || nextIndex >= saved.tracks.length)) return;
    const [track] = saved.tracks.splice(index, 1);
    if (action !== 'remove') saved.tracks.splice(nextIndex, 0, track);
    write(saved.tracks, saved.openedAt);
    apply(saved.tracks);
  }

  // Navidrome 0.64.2 doesn't expose a ref from its share view. Keep the bridge to
  // that pinned component here; its own player still handles audio and rendering.
  function findPlayer(element) {
    if (!element) return null;
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    for (let fiber = element[key]; fiber; fiber = fiber.return) {
      const instance = fiber.stateNode;
      if (instance?.getPlayInfoOfNewList && instance?.resetAudioStatus) return instance;
    }
    return null;
  }

  function mountControls() {
    const panel = document.querySelector('.audio-lists-panel');
    if (!player) {
      player = findPlayer(panel);
      if (!player) return;
      apply(read().tracks);
    }
    const isOpen = panel?.classList.contains('show');
    if (isOpen && !panelOpen) touch();
    panelOpen = isOpen;
    if (!isOpen) return;
    // Explicit move buttons work on touch screens and with a keyboard.
    if (player.sortable && !player.sortable.option('disabled')) player.sortable.option('disabled', true);
    const items = player.state.audioLists;
    panel.querySelectorAll('.audio-item').forEach((row, index) => {
      const item = items[index];
      if (!item) return;
      let controls = row.querySelector('.t2-nd-queue-actions');
      if (!controls) {
        controls = document.createElement('span');
        controls.className = 't2-nd-queue-actions';
        for (const [action, symbol, label] of [['up', '↑', '上移'], ['down', '↓', '下移'], ['remove', '×', '从播放列表移除']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.action = action;
          button.textContent = symbol;
          button.title = label;
          button.setAttribute('aria-label', label);
          controls.append(button);
        }
        controls.addEventListener('click', event => {
          event.stopPropagation();
          const action = event.target.closest('button')?.dataset.action;
          if (action) edit(controls.dataset.track, action);
        });
        row.append(controls);
      }
      controls.dataset.track = idFromUrl(item.musicSrc);
      controls.children[0].disabled = index === 0;
      controls.children[1].disabled = index === items.length - 1;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Navidrome renders the player as a portal outside its root element.
    new MutationObserver(mountControls).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    });
    mountControls();
  }, { once: true });

  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) apply(read().tracks);
  });
  window.addEventListener('message', event => {
    if (window.parent !== window && event.source === window.parent && event.origin === location.origin &&
        event.data?.tree2Player === 'opened') touch();
  });

  // Navidrome's download handler refers to the share ID, which is the first opened file.
  document.addEventListener('click', event => {
    if (!event.target.closest?.('.audio-download')) return;
    event.preventDefault();
    event.stopPropagation();
    const active = current();
    if (!active) return;
    const link = document.createElement('a');
    link.href = `${base}/d/${active.id}`;
    link.download = '';
    link.click();
  }, true);

  window.tree2VinylPlaylist = { current };
})();
