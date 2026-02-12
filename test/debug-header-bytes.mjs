#!/usr/bin/env node
/**
 * Debug: inspect object header bytes at specific addresses
 */
import { openSync, readSync, closeSync, statSync } from 'fs';
import { resolve } from 'path';

const h5FilePath = process.argv[2] || '/mnt/c/Users/nicks/Downloads/NISAR_L2_PR_GCOV_013_120_D_075_2005_QPDH_A_20251224T125029_20251224T125103_P05006_N_F_J_001.h5';

const fd = openSync(resolve(h5FilePath), 'r');

function readAt(offset, length) {
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, offset);
  return buf;
}

function hexDump(buf, offset, count = 64) {
  const bytes = [];
  for (let i = 0; i < Math.min(count, buf.length); i++) {
    bytes.push(buf[i].toString(16).padStart(2, '0'));
  }
  // Group by 16
  for (let i = 0; i < bytes.length; i += 16) {
    const addr = (offset + i).toString(16).padStart(8, '0');
    const hex = bytes.slice(i, i + 16).join(' ');
    const ascii = Array.from(buf.slice(i, i + 16))
      .map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.')
      .join('');
    console.log(`  ${addr}: ${hex.padEnd(48)}  ${ascii}`);
  }
}

// Check addresses of VVVV (0x3ed08) and mask (0x66f88)
// Also check HHHH for comparison (from test: dataset_28b8 → address 0x28b8)
const addresses = {
  'HHHH': 0x28b8,
  'HVHV': 0x16a40,
  'VHVH': 0x2ab60,
  'VVVV': 0x3ed08,
  'mask': 0x66f88,
};

for (const [name, addr] of Object.entries(addresses)) {
  console.log(`\n=== ${name} at 0x${addr.toString(16)} ===`);
  const buf = readAt(addr, 128);
  hexDump(buf, addr, 128);

  // Check if it's a v1 header (version byte = 1) or v2 (OHDR)
  const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (sig === 'OHDR') {
    console.log(`  → v2 object header (OHDR)`);
    const version = buf[4];
    const flags = buf[5];
    console.log(`  → version=${version}, flags=0x${flags.toString(16)}`);
  } else if (buf[0] === 1) {
    console.log(`  → v1 object header (version=1)`);
    const numMessages = buf[2] | (buf[3] << 8);
    const refCount = buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24);
    const headerSize = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
    console.log(`  → numMessages=${numMessages}, refCount=${refCount}, headerSize=${headerSize}`);
  } else {
    console.log(`  → Unknown header format, first byte: ${buf[0]} (0x${buf[0].toString(16)})`);
  }
}

closeSync(fd);
