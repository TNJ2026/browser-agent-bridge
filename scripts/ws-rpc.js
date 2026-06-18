#!/usr/bin/env node
const crypto = require('crypto');
const net = require('net');

const args = process.argv.slice(2);
const usage = `Usage:
  scripts/ws-rpc.js '<json-rpc-request>'
  scripts/ws-rpc.js --listen

Examples:
  scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"1","method":"tabs.list","params":{}}'
  scripts/ws-rpc.js --listen
`;

if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(usage);
  process.exit(0);
}

const listenOnly = args.includes('--listen');
const requestArg = args.find(arg => arg !== '--listen');
const host = process.env.BROWSER_AGENT_BRIDGE_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.BROWSER_AGENT_BRIDGE_PORT || '8765', 10);
const path = process.env.BROWSER_AGENT_BRIDGE_WS_PATH || '/ws';
const token = process.env.BROWSER_AGENT_BRIDGE_TOKEN || '';

if (!listenOnly && !requestArg) {
  process.stderr.write(usage);
  process.exit(2);
}

let request = null;
if (requestArg) {
  try {
    request = JSON.parse(requestArg);
  } catch (error) {
    process.stderr.write(`Invalid JSON request: ${error.message}\n`);
    process.exit(2);
  }
}

const key = crypto.randomBytes(16).toString('base64');
const socket = net.createConnection({ host, port });
let handshakeBuffer = Buffer.alloc(0);
let frameBuffer = Buffer.alloc(0);
let handshakeDone = false;
let sentRequest = false;
let finished = false;

socket.setNoDelay(true);

socket.on('connect', () => {
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13'
  ];
  if (token) headers.push(`Authorization: Bearer ${token}`);
  socket.write([...headers, '', ''].join('\r\n'));
});

socket.on('data', chunk => {
  if (finished) return;
  if (!handshakeDone) {
    handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
    const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = handshakeBuffer.subarray(0, headerEnd).toString('utf8');
    try {
      validateHandshake(header);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      finished = true;
      socket.end();
      return;
    }
    handshakeDone = true;

    const rest = handshakeBuffer.subarray(headerEnd + 4);
    handshakeBuffer = Buffer.alloc(0);
    if (request && !sentRequest) {
      sentRequest = true;
      socket.write(encodeFrame(JSON.stringify(request)));
    }
    if (rest.length > 0) frameBuffer = Buffer.concat([frameBuffer, rest]);
  } else {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
  }

  readFrames();
});

socket.on('error', error => {
  if (finished) return;
  finished = true;
  process.stderr.write(`WebSocket error: ${error.message}\n`);
  process.exitCode = 1;
});

socket.on('close', () => {
  if (listenOnly) return;
  if (!sentRequest && request) process.exitCode = 1;
});

function validateHandshake(header) {
  const lines = header.split(/\r?\n/);
  if (!/^HTTP\/\d(?:\.\d)? 101\b/.test(lines[0])) {
    throw new Error(`WebSocket upgrade failed: ${lines[0] || 'missing status line'}`);
  }
  const headers = Object.fromEntries(lines.slice(1).map(line => {
    const index = line.indexOf(':');
    return index === -1 ? [line.toLowerCase(), ''] : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
  }));
  const expected = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  if (headers['sec-websocket-accept'] !== expected) {
    throw new Error('WebSocket upgrade failed: invalid Sec-WebSocket-Accept');
  }
}

function readFrames() {
  while (frameBuffer.length >= 2) {
    const first = frameBuffer[0];
    const second = frameBuffer[1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (frameBuffer.length < offset + 2) return;
      length = frameBuffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (frameBuffer.length < offset + 8) return;
      const high = frameBuffer.readUInt32BE(offset);
      const low = frameBuffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    if (frameBuffer.length < offset + length) return;
    const payload = frameBuffer.subarray(offset, offset + length);
    frameBuffer = frameBuffer.subarray(offset + length);

    if (opcode === 0x8) {
      finished = true;
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      socket.write(encodeFrame(payload, 0xA));
      continue;
    }
    if (opcode !== 0x1) continue;

    process.stdout.write(`${payload.toString('utf8')}\n`);
    if (!listenOnly && request && isResponseForRequest(payload)) {
      finished = true;
      socket.end();
      return;
    }
  }
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = crypto.randomBytes(4);
  const length = data.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }

  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function isResponseForRequest(payload) {
  if (!request || !Object.prototype.hasOwnProperty.call(request, 'id')) return true;
  try {
    const message = JSON.parse(payload.toString('utf8'));
    return Object.prototype.hasOwnProperty.call(message, 'id') && String(message.id) === String(request.id);
  } catch {
    return false;
  }
}
