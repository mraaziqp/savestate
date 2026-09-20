/**
 * Unit Test: Google Drive Resumable Upload Pipeline & Strict 256 KiB Chunk Alignment
 * Verifies:
 * 1. Dual drive endpoint registration.
 * 2. Session initiation with SHA-256 hash tracking.
 * 3. Strict 256 KiB (262,144 bytes) alignment rejection for invalid chunk sizes.
 * 4. Exact 262,144 byte chunk ingestion with HTTP 308 Resume Incomplete.
 * 5. Final chunk completion and status 'synced'.
 * 6. Deduplication check: identical SHA-256 hash returns deduplicated: true (0 SSD writes).
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 Running Resumable Upload & 256 KiB Chunk Alignment Tests');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name} ${details ? `(${details})` : ''}`);
      failed++;
    }
  }

  try {
    // 1. Dual Drive Endpoints
    console.log('Test 1: Fetch Dual Drive Endpoints');
    const epRes = await request({
      hostname: HOST,
      port: PORT,
      path: '/api/storage/gdrive/endpoints',
      method: 'GET',
    });
    assert(epRes.status === 200, 'Endpoints route returns HTTP 200');
    assert(Array.isArray(epRes.body?.endpoints), 'Returns array of endpoints');
    const hasPrimary = epRes.body?.endpoints?.some((e) => e.id === 'gdrive_primary');
    const hasMedia = epRes.body?.endpoints?.some((e) => e.id === 'gdrive_media');
    assert(hasPrimary && hasMedia, 'Contains gdrive_primary and gdrive_media endpoints');

    // 2. Resumable Session Handshake
    console.log('\nTest 2: Resumable Session Handshake (uploadType=resumable)');
    const testFileSize = 262144 * 2; // Exact 512 KiB (2 chunks of 256 KiB)
    const testFileHash = crypto.createHash('sha256').update(`test-file-${Date.now()}`).digest('hex');
    const testFileName = `test-rom-${Date.now()}.bin`;

    const initRes = await request(
      {
        hostname: HOST,
        port: PORT,
        path: '/api/storage/gdrive/resumable/init',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        fileName: testFileName,
        fileSize: testFileSize,
        mimeType: 'application/octet-stream',
        fileHash: testFileHash,
        driveTarget: 'gdrive_primary',
      })
    );

    assert(initRes.status === 201, 'Init session returns HTTP 201 Created');
    assert(!!initRes.body?.uploadId, 'Returns valid uploadId');
    assert(initRes.body?.chunkSize === 262144, 'Chunk size standard is 262,144 bytes (256 KiB)');
    assert(!!initRes.headers['location'], 'Returns Location header with session URI');

    const uploadId = initRes.body?.uploadId;

    // 3. Strict Chunk Alignment Check: Non-compliant chunk rejected
    console.log('\nTest 3: Reject Non-256 KiB Aligned Non-Final Chunk');
    const badChunkSize = 200000; // Not a multiple of 262,144
    const badChunkData = Buffer.alloc(badChunkSize, 0xaa);
    const badRes = await request(
      {
        hostname: HOST,
        port: PORT,
        path: `/api/storage/gdrive/resumable/session/${uploadId}`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes 0-${badChunkSize - 1}/${testFileSize}`,
        },
      },
      badChunkData
    );

    assert(badRes.status === 400, 'Rejects misaligned chunk with HTTP 400 Bad Request');
    assert(
      badRes.body?.error?.includes('256 KiB') || badRes.body?.error?.includes('alignment'),
      'Returns strict chunk alignment error message'
    );

    // 4. Ingest Compliant 256 KiB Chunk (Chunk 1)
    console.log('\nTest 4: Ingest Exactly 262,144 Bytes (Chunk 1 of 2)');
    const CHUNK_SIZE = 262144;
    const chunk1Data = Buffer.alloc(CHUNK_SIZE, 0x11);
    const chunk1Res = await request(
      {
        hostname: HOST,
        port: PORT,
        path: `/api/storage/gdrive/resumable/session/${uploadId}`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes 0-${CHUNK_SIZE - 1}/${testFileSize}`,
        },
      },
      chunk1Data
    );

    assert(chunk1Res.status === 308, 'Chunk 1 accepted with HTTP 308 Resume Incomplete');
    assert(chunk1Res.body?.chunkOffset === CHUNK_SIZE, `Chunk offset advances to ${CHUNK_SIZE}`);
    assert(chunk1Res.headers['range'] === `bytes 0-${CHUNK_SIZE - 1}`, 'Range header echoes byte range');

    // 5. Ingest Final Chunk (Chunk 2 of 2)
    console.log('\nTest 5: Ingest Final 262,144 Bytes (Chunk 2 of 2)');
    const chunk2Data = Buffer.alloc(CHUNK_SIZE, 0x22);
    const chunk2Res = await request(
      {
        hostname: HOST,
        port: PORT,
        path: `/api/storage/gdrive/resumable/session/${uploadId}`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${CHUNK_SIZE}-${testFileSize - 1}/${testFileSize}`,
        },
      },
      chunk2Data
    );

    assert(chunk2Res.status === 200, 'Final chunk completes upload with HTTP 200 OK');
    assert(chunk2Res.body?.status === 'synced', 'Status marked as "synced"');
    assert(chunk2Res.body?.completed === true, 'Upload completed successfully');

    // 6. Deduplication Check (Zero SSD writes on duplicate file)
    console.log('\nTest 6: Hash Deduplication (0 SSD writes)');
    const dedupRes = await request(
      {
        hostname: HOST,
        port: PORT,
        path: '/api/storage/gdrive/resumable/init',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        fileName: 'identical-copy.bin',
        fileSize: testFileSize,
        mimeType: 'application/octet-stream',
        fileHash: testFileHash,
        driveTarget: 'gdrive_primary',
      })
    );

    assert(dedupRes.status === 200, 'Duplicate init returns HTTP 200 OK');
    assert(dedupRes.body?.deduplicated === true, 'deduplicated: true returned');
    assert(dedupRes.body?.status === 'synced', 'Status is already "synced"');

    console.log('\n===============================================================');
    console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log('===============================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal test execution error:', error);
    process.exit(1);
  }
}

runTests();
