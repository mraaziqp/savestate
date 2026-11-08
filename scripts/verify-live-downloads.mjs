import http from "node:http";

const tests = [
  { path: "/SaveState.mobileconfig", expectedStatus: 200, contentType: "application/x-apple-aspen-config" },
  { path: "/api/downloads/ios-profile", expectedStatus: 200, contentType: "application/x-apple-aspen-config" },
  { path: "/api/downloads/ios", expectedStatus: 200, contentType: "application/x-apple-aspen-config" },
  { path: "/api/downloads/ios?format=ipa", expectedStatus: 302 },
  { path: "/api/downloads/ios-ipa", expectedStatus: 200, contentType: "application/octet-stream" },
  { path: "/api/updates/check?platform=ios", expectedStatus: 200 },
  { path: "/api/downloads/desktop?platform=windows", expectedStatus: 302 },
  { path: "/api/downloads/windows-portable", expectedStatus: 302 },
  { path: "/api/downloads/apk", expectedStatus: 200, contentType: "application/vnd.android.package-archive" },
  { path: "/api/downloads/vita", expectedStatus: 200 },
  { path: "/updates/SaveState-Setup-1.0.75.exe", expectedStatus: 200 },
  { path: "/updates/SaveState-Windows-Portable-1.0.75.zip", expectedStatus: 200 },
  { path: "/updates/SaveState-1.0.75.ipa", expectedStatus: 200 }
];

async function runTests() {
  console.log("=== Verifying Live Endpoints on http://127.0.0.1:3000 ===");
  let passed = 0;
  for (const t of tests) {
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: 3000,
          path: t.path,
          method: "GET",
          headers: { "User-Agent": "SaveStateVerification/1.0" }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            if (data.length < 500) data += chunk.toString();
          });
          res.on("end", () => {
            const statusOk = res.statusCode === t.expectedStatus;
            const typeOk = !t.contentType || (res.headers["content-type"] && res.headers["content-type"].includes(t.contentType));
            if (statusOk && typeOk) {
              console.log(`[PASS] ${t.path} -> ${res.statusCode} (${res.headers["content-type"] || "no-type"}) [${res.headers["content-length"] || "?"} bytes]`);
              passed++;
            } else {
              console.error(`[FAIL] ${t.path} -> got ${res.statusCode} (expected ${t.expectedStatus}), type: ${res.headers["content-type"]}`);
            }
            resolve();
          });
        }
      );
      req.on("error", (err) => {
        console.error(`[ERROR] ${t.path}: ${err.message}`);
        resolve();
      });
      req.end();
    });
  }
  console.log(`\nResults: ${passed}/${tests.length} tests passed.`);
  if (passed !== tests.length) process.exit(1);
}

runTests();
