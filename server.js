const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Show local IP on startup
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const activeStreams = {};

function getYtdlpStreamUrl(youtubeUrl, resolution) {
  const fmtMap = {
    '1080p': 'bestvideo[height<=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720p':  'bestvideo[height<=720][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480p':  'bestvideo[height<=480][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
    '360p':  'bestvideo[height<=360]+bestaudio/best[height<=360]',
  };
  const fmt = fmtMap[resolution] || fmtMap['720p'];
  try {
    const raw = execSync(
      `yt-dlp -f "${fmt}" -g --no-warnings "${youtubeUrl}"`,
      { timeout: 45000, encoding: 'utf8' }
    ).trim();
    // yt-dlp returns two URLs (video\naudio) for separate streams
    const lines = raw.split('\n').filter(Boolean);
    return { success: true, urls: lines };
  } catch (e) {
    // fallback: try best single stream
    try {
      const fb = execSync(
        `yt-dlp -f "best[height<=${resolution.replace('p','')}]/best" -g --no-warnings "${youtubeUrl}"`,
        { timeout: 45000, encoding: 'utf8' }
      ).trim();
      return { success: true, urls: [fb] };
    } catch (e2) {
      return { success: false, error: e2.stderr ? e2.stderr.toString().split('\n')[0] : e2.message };
    }
  }
}

function buildFFmpegArgs(urlData, rtmpUrl, resolution, loop, fps) {
  const scaleMap = { '1080p':'1920:1080','720p':'1280:720','480p':'854:480','360p':'640:360' };
  const bitrateMap = { '1080p':'4000k','720p':'2500k','480p':'1200k','360p':'800k' };
  const maxrateMap = { '1080p':'4500k','720p':'3000k','480p':'1500k','360p':'1000k' };
  const scale = scaleMap[resolution] || scaleMap['720p'];
  const bv = bitrateMap[resolution] || bitrateMap['720p'];
  const mr = maxrateMap[resolution] || maxrateMap['720p'];
  const outFps = parseInt(fps, 10) || 30;

  const args = ['-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:2', '-nostats'];

  if (loop) args.push('-stream_loop', '-1');

  if (urlData.urls.length >= 2) {
    // separate video + audio streams
    args.push('-re', '-i', urlData.urls[0], '-re', '-i', urlData.urls[1]);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-re', '-i', urlData.urls[0]);
  }

  args.push(
    '-vf', `scale=${scale},format=yuv420p`,
    '-r', String(outFps),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', bv,
    '-maxrate', mr,
    '-bufsize', '6000k',
    '-g', String(outFps * 2),
    '-keyint_min', String(outFps),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    rtmpUrl
  );
  return args;
}

function fmtDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

io.on('connection', (socket) => {
  socket.on('start_stream', ({ youtubeUrl, rtmpKey, platform, resolution, duration, loop, streamId, customRtmpUrl, fps, clientId }) => {
    let rtmpUrl;
    if (platform === 'custom') {
      rtmpUrl = (customRtmpUrl || '').trim();
      if (!rtmpUrl) { socket.emit('stream_error', { msg: 'Custom RTMP URL required' }); return; }
    } else {
      const bases = {
        facebook: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        youtube:  'rtmp://a.rtmp.youtube.com/live2/',
        twitch:   'rtmp://live.twitch.tv/app/',
        instagram:'rtmp://live-upload.instagram.com:443/rtmp/',
      };
      rtmpUrl = (bases[platform] || bases.youtube) + rtmpKey;
    }

    const outFps = parseInt(fps, 10) || 30;

    socket.emit('log', { type: 'info', msg: `Fetching stream URL...` });
    socket.emit('log', {
      type: 'info',
      msg: `Platform: ${platform.toUpperCase()} | Quality: ${resolution} | ${outFps} fps | ${loop ? '24/7 Loop' : `Timed: ${duration} min`}`,
    });

    const urlData = getYtdlpStreamUrl(youtubeUrl, resolution);
    if (!urlData.success) {
      socket.emit('log', { type: 'error', msg: `yt-dlp failed: ${urlData.error}` });
      socket.emit('stream_error', { msg: urlData.error });
      return;
    }

    socket.emit('log', { type: 'success', msg: `Stream URL ready (${urlData.urls.length} track${urlData.urls.length>1?'s':''})` });
    socket.emit('log', { type: 'info', msg: `Starting FFmpeg encoder...` });

    const args = buildFFmpegArgs(urlData, rtmpUrl, resolution, loop, outFps);
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const stream = {
      streamId, ffmpeg, startTime: Date.now(), duration, loop, fps: outFps,
      started: false, startedAt: null, finished: false, finish: null,
      ownerId: clientId || null, platform, resolution, lastStats: null,
    };
    activeStreams[streamId] = stream;

    let started = false;
    let startTimeout = null;
    let durationTimeout = null;
    let progress = {};
    let stderrBuf = '';
    let lastStatsEmit = 0;

    // "Started" is only true once FFmpeg actually encodes and pushes frames.
    function markStarted() {
      if (started || stream.finished) return;
      started = true;
      stream.started = true;
      stream.startedAt = Date.now();
      clearTimeout(startTimeout);
      // Duration countdown starts from the real stream start, not process spawn
      if (!loop && duration > 0 && !durationTimeout) {
        durationTimeout = setTimeout(() => {
          if (!stream.finished) {
            ffmpeg.kill('SIGTERM');
            finish('duration');
          }
        }, duration * 60 * 1000);
      }
      io.emit('log', { type: 'success', msg: `Streaming started — ${outFps} fps` });
      io.emit('stream_started', { streamId, startedAt: stream.startedAt });    }

    // Exactly one end log/event per stream, whichever way it stops.
    function finish(reason) {
      if (stream.finished) return;
      stream.finished = true;
      clearTimeout(startTimeout);
      clearTimeout(durationTimeout);
      const ranSec = stream.startedAt ? Math.floor((Date.now() - stream.startedAt) / 1000) : 0;
      const label = reason === 'stopped' ? 'Stream stopped'
                  : reason === 'duration' ? 'Duration complete'
                  : reason === 'error' ? 'Stream failed'
                  : 'Stream ended';
      io.emit('log', {
        type: reason === 'error' ? 'error' : 'success',
        msg: `${label} — total ${fmtDuration(ranSec)}${stream.started ? '' : ' (never started)'}`,
      });
      io.emit('stream_ended', { streamId, reason, ranSec });
      delete activeStreams[streamId];
    }
    stream.finish = finish;

    startTimeout = setTimeout(() => {
      if (!started && !stream.finished) {
        io.emit('log', { type: 'error', msg: `Stream start timeout — no data sent. Check stream key / network.` });
        ffmpeg.kill('SIGTERM');
      }
    }, 30000);

    ffmpeg.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      const parts = stderrBuf.split('\n');
      stderrBuf = parts.pop(); // keep incomplete trailing line
      parts.forEach(rawLine => {
        const line = rawLine.trim();
        if (!line) return;

        // -progress pipe:2 output (key=value blocks) — used for live stats only
        const m = /^(frame|fps|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=(.*)$/.exec(line);
        if (m) {
          progress[m[1]] = m[2];
          if (m[1] === 'progress') {
            const frame = parseInt(progress.frame || '0', 10);
            if (frame > 0) markStarted();
            const now = Date.now();
            if (started && !stream.finished && now - lastStatsEmit >= 2000) {
              lastStatsEmit = now;
              const measured = parseFloat(progress.fps || '0') || 0;
              stream.lastStats = {
                frame,
                fps: measured > 0 ? measured : outFps,
                speed: (progress.speed || '').trim(),
                bitrate: (progress.bitrate || '').trim(),
                uptime: Math.floor((now - (stream.startedAt || now)) / 1000),
              };
              io.emit('stream_stats', { streamId, ...stream.lastStats });
            }
            progress = {};
          }
          return;
        }

        // Only real FFmpeg warnings/errors reach the log — no periodic spam
        socket.emit('log', { type: 'ffmpeg', msg: line });
      });
    });

    ffmpeg.on('close', (code) => {
      if (stream.finished) return;
      if (code !== 0) io.emit('stream_error', { msg: `FFmpeg exited (code ${code})`, streamId });
      finish(code === 0 ? 'ended' : 'error');
    });

    ffmpeg.on('error', (err) => {
      if (stream.finished) return;
      io.emit('stream_error', { msg: err.message, streamId });
      finish('error');
    });
  });

  // Restore UI state after a page refresh / reconnect
  socket.on('get_state', ({ clientId, streamId } = {}) => {
    let stream = streamId ? activeStreams[streamId] : null;
    if (!stream && clientId) {
      const mine = Object.values(activeStreams).filter(s => s.ownerId === clientId);
      stream = mine[mine.length - 1] || null;
    }
    if (!stream) {
      const all = Object.values(activeStreams);
      if (all.length === 1) stream = all[0];
    }
    if (!stream) {
      socket.emit('stream_state', { active: false });
      return;
    }
    socket.emit('stream_state', {
      active: true,
      streamId: stream.streamId,
      started: stream.started,
      startedAt: stream.startedAt,
      loop: stream.loop,
      duration: stream.duration,
      platform: stream.platform,
      resolution: stream.resolution,
      fps: stream.fps,
      stats: stream.lastStats || null,
    });
  });

  socket.on('stop_stream', ({ streamId }) => {
    const stream = activeStreams[streamId];
    if (!stream) return;
    stream.finish('stopped');
    stream.ffmpeg.kill('SIGTERM');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log(`\n✅  ReStream running`);
  console.log(`   Local  : http://localhost:${PORT}`);
  console.log(`   Network: http://${ip}:${PORT}\n`);
});
