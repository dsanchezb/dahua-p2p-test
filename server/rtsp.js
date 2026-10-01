'use strict';

/**
 * Builds the RTSP URL for a given channel/subtype against the local RTSP
 * proxy that dh-p2p exposes once its tunnel is up. `rtspPort` is the local
 * port passed to `startDhP2pTunnel`; `host` defaults to the loopback proxy
 * address but is overridable mainly for tests.
 */
function buildRtspUrl({ username, password, rtspPort, channel, subtype, host = '127.0.0.1' }) {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  const ch = encodeURIComponent(channel);
  const st = encodeURIComponent(subtype);
  return `rtsp://${user}:${pass}@${host}:${rtspPort}/cam/realmonitor?channel=${ch}&subtype=${st}`;
}

module.exports = { buildRtspUrl };
