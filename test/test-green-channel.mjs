import { openH5ChunkFile } from '../src/loaders/h5chunk.js';
import fs from 'fs';

const filePath = 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
const file = {
  name: filePath.split('/').pop(),
  size: fs.statSync(filePath).size,
  slice: (start, end) => {
    const buf = Buffer.alloc(end - start);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, end - start, start);
    fs.closeSync(fd);
    return { arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) };
  }
};

const reader = await openH5ChunkFile(file, 32 * 1024 * 1024);
const h5Datasets = reader.getDatasets();
const ds2d = h5Datasets.filter(d => d.shape && d.shape.length === 2);

console.log('2D datasets:', ds2d.length);
for (const d of ds2d) {
  console.log('  id=' + d.id, 'shape=' + d.shape.join('x'), 'dtype=' + d.dtype);

  const [h, w] = d.shape;
  const chunkH = d.chunkDims ? d.chunkDims[0] : 512;
  const chunkW = d.chunkDims ? d.chunkDims[1] : 512;
  const midRow = Math.floor(h / chunkH / 2);
  const midCol = Math.floor(w / chunkW / 2);

  try {
    const chunk = await reader.readChunk(d.id, midRow, midCol);
    if (chunk) {
      let sum = 0, count = 0, zeros = 0, nans = 0;
      for (let i = 0; i < chunk.length; i++) {
        const v = chunk[i];
        if (isNaN(v)) { nans++; }
        else if (v > 0) { sum += v; count++; }
        else if (v === 0) { zeros++; }
      }
      const mean = count > 0 ? sum / count : 0;
      const dB = mean > 0 ? (10 * Math.log10(mean)).toFixed(1) : '-inf';
      console.log('    chunk[' + midRow + ',' + midCol + ']: total=' + chunk.length +
        ' nonzero=' + count + ' zeros=' + zeros + ' nans=' + nans +
        ' mean=' + mean.toExponential(3) + ' (' + dB + ' dB)');
    } else {
      console.log('    chunk read returned null');
    }
  } catch (e) {
    console.log('    chunk read error:', e.message);
  }
}

// Now test classification 
console.log('\n--- classifyDatasets heuristic ---');
const targetShape = ds2d[0].shape;
const matching = ds2d.filter(d => d.shape[0] === targetShape[0] && d.shape[1] === targetShape[1]);
console.log('Matching shape datasets:', matching.length);

const means = [];
for (const ds of matching) {
  const [h, w] = ds.shape;
  const chunkH = ds.chunkDims ? ds.chunkDims[0] : 512;
  const chunkW = ds.chunkDims ? ds.chunkDims[1] : 512;
  const midRow = Math.floor(h / chunkH / 2);
  const midCol = Math.floor(w / chunkW / 2);

  let mean = 0;
  try {
    const chunk = await reader.readChunk(ds.id, midRow, midCol);
    if (chunk) {
      let s = 0, c = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (!isNaN(chunk[i]) && chunk[i] > 0) { s += chunk[i]; c++; }
      }
      mean = c > 0 ? s / c : 0;
    }
  } catch (e) {}

  const dB = mean > 0 ? 10 * Math.log10(mean) : -999;
  means.push({ id: ds.id, mean, dB });
  console.log('  ' + ds.id + ': mean=' + mean.toExponential(3) + ' (' + dB.toFixed(1) + ' dB)');
}

means.sort((a, b) => b.mean - a.mean);
const dbDiff = means[0].dB - means[1].dB;
console.log('dB difference:', dbDiff.toFixed(1));
console.log('Classification:');
console.log('  means[0] (' + means[0].id + ') → HHHH (co-pol)');
console.log('  means[1] (' + means[1].id + ') → ' + (dbDiff > 3 ? 'HVHV' : 'VVVV') + ' (cross-pol)');
