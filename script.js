/* ========== CONFIG ========== */
const CROSSFADE = 2.0; // seconds
const trackItems = Array.from(document.querySelectorAll('.track-item'));
const globalPlayer = document.getElementById('globalPlayer');
const playerTitle = document.getElementById('playerTitle');
const playerArtist = document.getElementById('playerArtist');
const playerArt = document.getElementById('playerArt');
const playerTitleMini = document.getElementById('playerTitleMini');
const playerArtistMini = document.getElementById('playerArtistMini');
const playerArtMini = document.getElementById('playerArtMini');
const playPauseBtn = document.getElementById('playPauseBtn');
const playPauseBtnMini = document.getElementById('playPauseBtnMini');
const prevBtn = document.getElementById('prevBtn');
const prevBtnMini = document.getElementById('prevBtnMini');
const nextBtn = document.getElementById('nextBtn');
const nextBtnMini = document.getElementById('nextBtnMini');
const seekBar = document.getElementById('seekBar');
const seekBarMini = document.getElementById('seekBarMini');
const currentTimeEl = document.getElementById('currentTime');
const currentTimeMini = document.getElementById('currentTimeMini');
const totalTimeEl = document.getElementById('totalTime');
const totalTimeMini = document.getElementById('totalTimeMini');
const audioFallback = document.getElementById('audioFallback');
const shareBtn = document.getElementById('shareBtn');
const topShare = document.getElementById('topShare');
const downloadLink = document.getElementById('downloadLink');
const lyricsToggle = document.getElementById('lyricsToggle');
const lyricsBox = document.getElementById('lyricsBox');
const visualizer = document.getElementById('visualizer');

let currentIndex = -1;
let audioCtx = null;
let masterGain = null;
let analyser = null;
let activeSources = [];
let isPlaying = false;
let periodicUpdateTimer = null;
let vizTimer = null;
let lastBufferDuration = 0;

/* ===== Helpers ===== */
function formatTime(s){
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s/60), sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}
function setActiveTrackClass(idx){
  trackItems.forEach((t,i)=>t.classList.toggle('active', i===idx));
}
/* ===================== */

/* ===== MediaSession & handlers ===== */
function updateMediaSessionMeta(track){
  if (!('mediaSession' in navigator)) return;
  const art = track.dataset.art || 'square-image.jpg';
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.dataset.title,
      artist: track.dataset.artist,
      album: 'Purple Woman',
      artwork: [
        { src: art, sizes: '512x512', type: 'image/jpeg' },
        { src: art, sizes: '192x192', type: 'image/jpeg' }
      ]
    });
  } catch(e){/* ignore on unsupported */ }
}
function setupMediaSessionHandlers(){
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', async () => { await resume(); });
  navigator.mediaSession.setActionHandler('pause', () => { pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { prev(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { next(); });
}
/* =================================== */

/* ===== WebAudio init (with analyser) ===== */
function initAudioContext(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;

  // masterGain -> analyser -> destination
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);
}
/* ========================================= */

/* ===== Play buffer with crossfade ===== */
async function playBufferWithCrossfade(buffer, whenStart = 0, fadeIn = CROSSFADE, id = null){
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.0001;
  src.connect(gain);
  gain.connect(masterGain);

  const startTime = whenStart || audioCtx.currentTime;
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(1.0, startTime + fadeIn);

  src.start(startTime);
  src._startTime = startTime;
  src._gainNode = gain;
  src._id = id;

  src.onended = () => {
    activeSources = activeSources.filter(s => s !== src);
    if (activeSources.length === 0){
      if (currentIndex < trackItems.length - 1) {
        setTimeout(()=>{ loadTrack(currentIndex + 1); }, 40);
      } else {
        isPlaying = false;
        togglePlayIcon(false);
        stopPeriodicUpdates();
        stopVisualizer();
      }
    }
  };

  activeSources.push(src);
  return src;
}
/* ========================================= */

/* ===== Fade out and stop ===== */
function fadeOutAndStopSrc(src, fade = CROSSFADE){
  if (!src || !src._gainNode) return;
  const g = src._gainNode.gain;
  const now = audioCtx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.exponentialRampToValueAtTime(0.0001, now + fade);
  try { src.stop(now + fade + 0.05); } catch (e) {}
}
/* ========================================= */

/* ===== Fetch & decode ===== */
async function fetchAndDecode(url){
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load: ' + url);
  const ab = await response.arrayBuffer();
  return await audioCtx.decodeAudioData(ab);
}
/* ========================================= */

/* ===== Primary loader with crossfade ===== */
async function loadTrack(index){
  if (index < 0 || index >= trackItems.length) return;
  initAudioContext();
  const nextTrack = trackItems[index];
  const srcUrl = nextTrack.dataset.src;

  if (!audioCtx || !audioCtx.decodeAudioData) {
    return fallbackLoad(index);
  }

  try {
    currentIndex = index;
    setActiveTrackClass(index);

    // UI update
    playerTitle.textContent = nextTrack.dataset.title;
    playerArtist.textContent = nextTrack.dataset.artist;
    playerArt.src = nextTrack.dataset.art || 'square-image.jpg';
    playerArtMini.src = nextTrack.dataset.art || 'square-image.jpg';
    playerTitleMini.textContent = nextTrack.dataset.title;
    playerArtistMini.textContent = nextTrack.dataset.artist;
    globalPlayer.classList.remove('hidden');
    updateMediaSessionMeta(nextTrack);
    setupMediaSessionHandlers();

    const buffer = await fetchAndDecode(srcUrl);
    lastBufferDuration = buffer.duration;

    const now = audioCtx.currentTime;
    if (activeSources.length > 0){
      const newStart = now + 0.05;
      const newSrc = await playBufferWithCrossfade(buffer, newStart, CROSSFADE, index);
      activeSources.slice().forEach(old => { if (old !== newSrc) fadeOutAndStopSrc(old, CROSSFADE); });
      totalTimeEl.textContent = formatTime(buffer.duration);
      totalTimeMini.textContent = formatTime(buffer.duration);
      startPeriodicUpdates(buffer.duration, newStart, newSrc);
    } else {
      const newSrc = await playBufferWithCrossfade(buffer, now + 0.05, Math.min(0.5, CROSSFADE), index);
      totalTimeEl.textContent = formatTime(buffer.duration);
      totalTimeMini.textContent = formatTime(buffer.duration);
      startPeriodicUpdates(buffer.duration, now + 0.05, newSrc);
    }

    isPlaying = true;
    togglePlayIcon(true);
    startVisualizer();

    // set download link to current track (user can change)
    downloadLink.href = srcUrl;
    downloadLink.setAttribute('download', `${nextTrack.dataset.title} - ${nextTrack.dataset.artist}.mp3`);

  } catch (err){
    console.error('Playback error', err);
    fallbackLoad(index);
  }
}
/* ========================================= */

/* ===== Fallback using <audio> ===== */
function fallbackLoad(index){
  const t = trackItems[index];
  if (!t) return;
  currentIndex = index;
  setActiveTrackClass(index);
  playerTitle.textContent = t.dataset.title;
  playerArtist.textContent = t.dataset.artist;
  playerArt.src = t.dataset.art || 'square-image.jpg';
  playerArtMini.src = t.dataset.art || 'square-image.jpg';
  audioFallback.src = t.dataset.src;
  audioFallback.play().then(()=> {
    isPlaying = true;
    globalPlayer.classList.remove('hidden');
    updateMediaSessionMeta(t);
    setupMediaSessionHandlers();
    togglePlayIcon(true);
    totalTimeEl.textContent = formatTime(audioFallback.duration);
    totalTimeMini.textContent = formatTime(audioFallback.duration);
    if (!periodicUpdateTimer) periodicUpdateTimer = setInterval(()=> {
      seekBar.value = (audioFallback.currentTime / audioFallback.duration) * 100 || 0;
      seekBarMini.value = seekBar.value;
      currentTimeEl.textContent = formatTime(audioFallback.currentTime);
      currentTimeMini.textContent = formatTime(audioFallback.currentTime);
    }, 300);
  }).catch(e=>console.log('Fallback play prevented',e));
}
/* ========================================= */

/* ===== Periodic updates ===== */
function startPeriodicUpdates(bufferDuration, startWhen, src){
  stopPeriodicUpdates();
  const startTime = src._startTime || startWhen || audioCtx.currentTime;
  const duration = bufferDuration;
  totalTimeEl.textContent = formatTime(duration);
  totalTimeMini.textContent = formatTime(duration);

  periodicUpdateTimer = setInterval(()=> {
    const now = audioCtx.currentTime;
    const elapsed = Math.max(0, now - startTime);
    if (elapsed >= duration - 0.05){
      seekBar.value = 100;
      seekBarMini.value = 100;
      currentTimeEl.textContent = formatTime(duration);
      currentTimeMini.textContent = formatTime(duration);
    } else {
      seekBar.value = (elapsed / duration) * 100 || 0;
      seekBarMini.value = seekBar.value;
      currentTimeEl.textContent = formatTime(elapsed);
      currentTimeMini.textContent = formatTime(elapsed);
    }
  }, 250);
}
function stopPeriodicUpdates(){
  if (periodicUpdateTimer){ clearInterval(periodicUpdateTimer); periodicUpdateTimer = null; }
}
/* ========================================= */

/* ===== Play / Pause / Resume ===== */
async function resume(){
  if (!audioCtx) initAudioContext();
  if (audioCtx && audioCtx.state === 'suspended'){
    try { await audioCtx.resume(); } catch(e){ console.warn(e); }
  }
  if (!isPlaying){
    if (currentIndex === -1) {
      await loadTrack(0);
    } else {
      if (audioFallback && !audioFallback.paused){
        await audioFallback.play();
      } else if (activeSources.length === 0) {
        await loadTrack(currentIndex);
      } else {
        // already playing via WebAudio
      }
      isPlaying = true;
      togglePlayIcon(true);
      startVisualizer();
    }
  }
}
function pause(){
  if (audioCtx && audioCtx.state === 'running'){
    audioCtx.suspend().then(()=> {
      isPlaying = false;
      togglePlayIcon(false);
      stopVisualizer();
    });
  } else if (audioFallback && !audioFallback.paused){
    audioFallback.pause();
    isPlaying = false;
    togglePlayIcon(false);
    stopVisualizer();
  }
}
/* ========================================= */

/* ===== Next / Prev ===== */
function next(){ if (currentIndex < trackItems.length - 1) loadTrack(currentIndex + 1); else loadTrack(0); }
function prev(){ if (currentIndex > 0) loadTrack(currentIndex - 1); else loadTrack(0); }
/* ========================================= */

/* ===== Toggle Play Icon ===== */
function togglePlayIcon(play){
  const btns = document.querySelectorAll('.play-pause');
  btns.forEach(b=>{
    const playIcon = b.querySelector('.icon-play');
    const pauseIcon = b.querySelector('.icon-pause');
    if (play){
      playIcon.style.display = 'none'; pauseIcon.style.display = 'block';
    } else {
      playIcon.style.display = 'block'; pauseIcon.style.display = 'none';
    }
  });
}
/* ========================================= */

/* ===== Seek support ===== */
async function seekToPercent(pct){
  if (audioFallback && audioFallback.duration){
    audioFallback.currentTime = pct * audioFallback.duration;
  } else {
    if (currentIndex >= 0 && audioCtx){
      try {
        const t = trackItems[currentIndex];
        const buffer = await fetchAndDecode(t.dataset.src);
        activeSources.slice().forEach(s => { try { s.stop(); } catch(e){} });
        activeSources = [];
        const offset = pct * buffer.duration;
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        const g = audioCtx.createGain();
        g.gain.value = 1;
        src.connect(g); g.connect(masterGain);
        const now = audioCtx.currentTime + 0.05;
        src.start(now, offset);
        src._startTime = now - offset;
        activeSources.push(src);
        totalTimeEl.textContent = formatTime(buffer.duration);
        totalTimeMini.textContent = formatTime(buffer.duration);
        startPeriodicUpdates(buffer.duration, now - offset, src);
        isPlaying = true;
        togglePlayIcon(true);
      } catch (err){ console.error('Seek error', err); }
    }
  }
}
/* ========================================= */

/* ===== Wire UI buttons & events ===== */
playPauseBtn.addEventListener('click', async () => { if (!isPlaying) await resume(); else pause(); });
playPauseBtnMini.addEventListener('click', async () => { if (!isPlaying) await resume(); else pause(); });
prevBtn.addEventListener('click', () => prev());
prevBtnMini.addEventListener('click', () => prev());
nextBtn.addEventListener('click', () => next());
nextBtnMini.addEventListener('click', () => next());

seekBar.addEventListener('input', async (e) => { const pct = Number(e.target.value)/100; await seekToPercent(pct); });
seekBarMini.addEventListener('input', async (e) => { const pct = Number(e.target.value)/100; await seekToPercent(pct); });

trackItems.forEach((el, idx) => {
  el.addEventListener('click', async () => {
    if (!audioCtx){
      try { initAudioContext(); await audioCtx.resume(); } catch(e){}
    }
    if (currentIndex === idx && isPlaying){ pause(); return; }
    loadTrack(idx);
  });
  // keyboard "Enter" support
  el.addEventListener('keydown', (ev)=>{ if (ev.key === 'Enter') el.click(); });
});

/* Fallback audio events */
audioFallback.addEventListener('loadedmetadata', () => {
  totalTimeEl.textContent = formatTime(audioFallback.duration);
  totalTimeMini.textContent = formatTime(audioFallback.duration);
});
audioFallback.addEventListener('timeupdate', () => {
  currentTimeEl.textContent = formatTime(audioFallback.currentTime);
  currentTimeMini.textContent = formatTime(audioFallback.currentTime);
  seekBar.value = (audioFallback.currentTime / audioFallback.duration) * 100 || 0;
  seekBarMini.value = seekBar.value;
});
audioFallback.addEventListener('ended', () => {
  isPlaying = false;
  togglePlayIcon(false);
  if (currentIndex < trackItems.length - 1) loadTrack(currentIndex + 1);
});

/* Media Session init */
setupMediaSessionHandlers();

/* ===== Visibility: try to resume on hidden (helps mobile lock) ===== */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && audioCtx && audioCtx.state === 'suspended'){
    audioCtx.resume().catch(()=>{});
  }
});

/* ===== Keyboard shortcuts ===== */
document.addEventListener('keydown', (e)=>{
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); if (!isPlaying) resume(); else pause(); }
  if (e.code === 'ArrowRight') { next(); }
  if (e.code === 'ArrowLeft') { prev(); }
});

/* ===== Share handlers ===== */
async function shareTrack(){
  if (currentIndex < 0) return;
  const t = trackItems[currentIndex];
  const payload = { title: t.dataset.title, text: `Listening to "${t.dataset.title}" by 0teazy 🎧`, url: window.location.href };
  try {
    if (navigator.share) {
      await navigator.share(payload);
    } else {
      // fallback: copy URL to clipboard and notify
      await navigator.clipboard.writeText(window.location.href);
      alert('Link copied to clipboard. Share it where you want!');
    }
  } catch (err){ console.warn('Share failed', err); }
}
shareBtn.addEventListener('click', shareTrack);
topShare.addEventListener('click', async ()=> {
  try { await shareTrack(); } catch(e){}
});
topShare.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') shareTrack(); });

/* ===== Lyrics toggle ===== */
lyricsToggle.addEventListener('click', ()=> {
  const open = lyricsBox.style.display !== 'block';
  lyricsBox.style.display = open ? 'block' : 'none';
  lyricsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});

/* ===== Visualizer using analyser ===== */
function startVisualizer(){
  if (!analyser || !audioCtx) return;
  stopVisualizer();
  const bars = Array.from(visualizer.querySelectorAll('.bar'));
  const bufferLength = analyser.frequencyBinCount;
  const freqData = new Uint8Array(bufferLength);

  function draw(){
    analyser.getByteFrequencyData(freqData);
    const step = Math.floor(freqData.length / bars.length);
    bars.forEach((bar, i) => {
      const val = freqData[i*step] || 0;
      const h = Math.max(5, Math.round((val/255) * 32));
      bar.style.height = h + 'px';
      bar.style.background = `rgba(0,0,0,${0.95 - (i*0.08)})`;
    });
    vizTimer = requestAnimationFrame(draw);
  }
  vizTimer = requestAnimationFrame(draw);
}
function stopVisualizer(){ if (vizTimer) { cancelAnimationFrame(vizTimer); vizTimer = null; } }

/* ===== Stop audio on page unload (clean) ===== */
window.addEventListener('pagehide', ()=> {
  if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
});

/* Expose debug API */
window._PW = { loadTrack, next, prev, resume, pause };

/* Accessibility: attempt to hint user to interact to enable audio on mobile */
if ('ontouchstart' in window && !sessionStorage.getItem('pw_interacted')) {
  // brief, non-intrusive hint
  const hint = document.createElement('div');
  hint.textContent = 'Tap a track to start playback';
  hint.style.position='fixed';
  hint.style.bottom='22px';
  hint.style.left='50%';
  hint.style.transform='translateX(-50%)';
  hint.style.background='rgba(0,0,0,0.5)';
  hint.style.color='#fff';
  hint.style.padding='8px 12px';
  hint.style.borderRadius='10px';
  hint.style.zIndex=99999;
  hint.style.fontSize='13px';
  document.body.appendChild(hint);
  setTimeout(()=>{ hint.remove(); sessionStorage.setItem('pw_interacted','1'); }, 3500);
}