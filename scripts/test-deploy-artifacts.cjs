#!/usr/bin/env node
/**
 * Deployment artefact verification.
 *
 * Docker and the AWS CLI are not installed on this host, so `docker build`
 * cannot be run here. These checks assert everything that IS verifiable
 * offline: that the Dockerfile stages reference real files, that the compose
 * and CloudFormation definitions parse, that no secret is baked into an image,
 * and that the Android project is genuinely TV-capable.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0, skip = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const note = (m) => { skip++; console.log(`  ○ ${m}`); };
const head = (m) => console.log(`\n── ${m}`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));

function testDockerfile() {
  head('Dockerfile');
  if (!has('Dockerfile')) return bad('Dockerfile missing');
  const d = read('Dockerfile');

  /FROM node:20-alpine/.test(d) ? ok('based on node:20-alpine') : bad('not alpine-based');
  (d.match(/^FROM /gm) || []).length >= 3 ? ok('multi-stage (build tooling stays out of the final image)') : bad('not multi-stage');
  /EXPOSE 3000/.test(d) ? ok('exposes 3000') : bad('port not exposed');
  /NODE_ENV=production/.test(d) ? ok('NODE_ENV=production') : bad('NODE_ENV not set');
  /USER node/.test(d) ? ok('runs unprivileged') : bad('runs as root');
  /HEALTHCHECK/.test(d) ? ok('has a healthcheck') : bad('no healthcheck');

  // ffmpeg is not optional here: most of the library cannot be played without it.
  /apk add[^\n]*ffmpeg/.test(d) ? ok('ffmpeg present in the runtime image') : bad('ffmpeg missing — most titles could not be transcoded');
  /tini/.test(d) ? ok('tini reaps ffmpeg children') : bad('no init — zombie ffmpeg processes');

  // No /dev/dri in a managed container; leaving hw transcode on would make
  // every launch fail rather than fall back.
  /NEXUS_DISABLE_HW_TRANSCODE=1/.test(d) ? ok('hardware transcode disabled for containers') : bad('hw transcode not disabled');

  // Statelessness: writable paths must be ephemeral.
  /NEXUS_DATA_DIR=\/tmp/.test(d) && /NEXUS_VAULT_FALLBACK=\/tmp/.test(d)
    ? ok('writable paths point at /tmp (stateless)') : bad('writes could land on the image layer');

  // Every COPY source must exist, or the build fails on the host with a
  // confusing "file not found" long after you have pushed.
  // Tolerate the extra whitespace Dockerfiles commonly use for alignment;
  // an earlier version of this regex read "--from=deps" as the source path.
  const copies = [...d.matchAll(/^COPY\s+(?:--from=\S+\s+)?(\S+)\s/gm)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith('/app') && !p.startsWith('--'));
  const missing = copies.filter((p) => !p.includes('*') && !has(p));
  missing.length === 0 ? ok(`all ${copies.length} COPY sources exist`) : bad(`COPY sources missing: ${missing.join(', ')}`);

  // Secrets must never be in the image.
  if (has('.dockerignore')) {
    const di = read('.dockerignore');
    /^\.env$/m.test(di) && /\.env\.\*/.test(di) ? ok('.env excluded from the build context') : bad('.env not excluded');
  } else bad('.dockerignore missing');
  /COPY .*\.env/.test(d) ? bad('Dockerfile copies a .env') : ok('no .env copied into the image');
}

function testCompose() {
  head('docker-compose (EC2 path)');
  if (!has('docker-compose.yml')) return bad('docker-compose.yml missing');
  const c = read('docker-compose.yml');
  /redis:/.test(c) ? ok('redis provisioned') : bad('no redis');
  /nginx:/.test(c) ? ok('nginx provisioned') : bad('no nginx');
  /read_only: true/.test(c) ? ok('app container is read-only') : bad('app filesystem writable');
  /expose:\s*\n\s*- "3000"/.test(c) ? ok('app port not published directly (nginx fronts it)') : note('app port exposure unclear');
  /env_file:/.test(c) ? ok('env injected from file, not inline') : bad('env not externalised');
}

function testNginx() {
  head('nginx wildcard routing');
  if (!has('nginx.conf')) return bad('nginx.conf missing');
  const n = read('nginx.conf');
  /server_name\s+savestate\.co\.za\s+\*\.savestate\.co\.za;/.test(n)
    ? ok('serves the apex and *.savestate.co.za from one block') : bad('wildcard server_name missing');
  // The app does its own per-tenant routing off the Host header.
  /proxy_set_header\s+Host\s+\$host;/.test(n) ? ok('original Host preserved for tenant routing') : bad('Host rewritten — tenant routing would break');
  /proxy_set_header\s+X-Forwarded-Host\s+\$host;/.test(n) ? ok('X-Forwarded-Host set') : bad('X-Forwarded-Host missing');
  /proxy_buffering\s+off;/.test(n) ? ok('buffering off (HTTP 206 range streaming)') : bad('buffering on — would break range streaming');
  /Upgrade/.test(n) && /connection_upgrade/.test(n) ? ok('WebSocket upgrade handled') : bad('WebSockets would fail');
  /proxy_read_timeout\s+3600s;/.test(n) ? ok('long media streams not cut at 60s') : bad('read timeout too short for film-length streams');
}

function testServerless() {
  head('Serverless (App Runner) deployment');
  if (!has('scripts/deploy-aws-serverless.sh')) return bad('deploy-aws-serverless.sh missing');
  const s = read('scripts/deploy-aws-serverless.sh');
  /aws ecr get-login-password/.test(s) ? ok('authenticates docker to ECR') : bad('no ECR auth');
  /docker build --platform linux\/amd64/.test(s) ? ok('builds linux/amd64 (Fargate rejects arm64 images)') : bad('platform not pinned');
  /create-repository/.test(s) ? ok('creates the ECR repo when absent') : bad('assumes the repo exists');
  /secretsmanager/.test(s) ? ok('secrets go to Secrets Manager') : bad('secrets not externalised');
  /cloudformation deploy/.test(s) ? ok('deploys via CloudFormation') : bad('no IaC deploy');
  /api\/health/.test(s) ? ok('polls /api/health after deploy') : bad('no health gate');
  // Passing a secret as a build arg or env on the command line leaks it into
  // shell history and process listings.
  /--build-arg[^\n]*(SECRET|TOKEN|KEY|PASSWORD)/i.test(s) ? bad('a secret is passed as a build arg') : ok('no secrets in build args');

  if (!has('aws-infrastructure.yaml')) return bad('aws-infrastructure.yaml missing');
  const y = read('aws-infrastructure.yaml');
  /AWS::AppRunner::Service/.test(y) ? ok('provisions an App Runner service') : bad('no App Runner service');
  /Port: '3000'/.test(y) ? ok('container port 3000 mapped') : bad('port not mapped');
  /RuntimeEnvironmentSecrets/.test(y) ? ok('secrets injected by ARN, not value') : bad('secrets inlined');
  /Path: \/api\/health/.test(y) ? ok('health check path set') : bad('no health check');
  // A wildcard secret grant would let the app read every secret in the account.
  /Resource: !Sub 'arn:aws:secretsmanager:\$\{AWS::Region\}:\$\{AWS::AccountId\}:secret:\$\{SecretName\}-\*'/.test(y)
    ? ok('instance role scoped to one secret') : bad('secret access is broader than one secret');
  /SecretArn:/.test(y) ? ok('SecretArn parameter declared') : bad('SecretArn referenced but never declared');
}

function testInit() {
  head('EC2 bootstrap');
  if (!has('scripts/aws-init.sh')) return bad('aws-init.sh missing');
  const s = read('scripts/aws-init.sh');
  /docker-ce|install -y -q docker/.test(s) ? ok('installs Docker') : bad('does not install Docker');
  /docker-compose-plugin|cli-plugins\/docker-compose/.test(s) ? ok('installs the compose plugin') : bad('no compose plugin');
  /awscli-exe-linux/.test(s) ? ok('installs the AWS CLI') : bad('no AWS CLI');
  /github\.com\/mraaziqp\/savestate\.git/.test(s) ? ok('clones the right repository') : bad('wrong or missing repo URL');
  /usermod -aG docker/.test(s) ? ok('adds the user to the docker group') : bad('docker would need sudo');
}

function testApk() {
  head('Android TV APK');
  if (!has('capacitor.config.ts')) return bad('capacitor.config.ts missing');
  const c = read('capacitor.config.ts');
  /appId: 'com\.savestate\.nexus'/.test(c) ? ok('appId com.savestate.nexus') : bad('wrong appId');
  /webDir: 'dist'/.test(c) ? ok("webDir points at dist/") : bad('webDir wrong');
  /savestate\.co\.za/.test(c) ? ok('thin client targets the live host') : bad('no server url');

  const M = 'android/app/src/main/AndroidManifest.xml';
  if (!has(M)) return bad('AndroidManifest.xml missing — run npx cap add android');
  const m = read(M);
  /LEANBACK_LAUNCHER/.test(m) ? ok('LEANBACK_LAUNCHER category (appears on TV home)') : bad('would be invisible on Android TV');
  /android\.software\.leanback"\s+android:required="false"/.test(m) ? ok('leanback not required (still installs on phones)') : bad('leanback requirement wrong');
  /android\.hardware\.touchscreen"\s+android:required="false"/.test(m) ? ok('touchscreen not required (TVs have none)') : bad('touchscreen requirement would hide it from TVs');
  /android:banner=/.test(m) ? ok('TV banner declared') : bad('no banner — some launchers reject the app');

  if (!has('scripts/build-apk.sh')) return bad('build-apk.sh missing');
  const b = read('scripts/build-apk.sh');
  /cap sync android/.test(b) ? ok('syncs web assets before building') : bad('no cap sync');
  /assembleDebug|assembleRelease/.test(b) ? ok('invokes gradle assemble') : bad('no gradle build');

  // The artefact itself, if it has been built.
  const apk = 'android/app/build/outputs/apk/debug/app-debug.apk';
  if (!has(apk)) return note('APK not built yet — run ./scripts/build-apk.sh');
  const size = fs.statSync(path.join(ROOT, apk)).size;
  size > 1e6 ? ok(`APK built (${(size / 1048576).toFixed(1)} MB)`) : bad(`APK suspiciously small (${size} bytes)`);
  try {
    const aapt = execFileSync('bash', ['-lc', 'ls ~/android-sdk/build-tools/*/aapt2 2>/dev/null | head -1'], { encoding: 'utf8' }).trim();
    if (!aapt) return note('aapt2 not found — skipped APK introspection');
    const badging = execFileSync(aapt, ['dump', 'badging', path.join(ROOT, apk)], { encoding: 'utf8', maxBuffer: 1 << 24 });
    /leanback-launchable-activity/.test(badging) ? ok('built APK is leanback-launchable') : bad('built APK is NOT leanback-launchable');
    /package: name='com\.savestate\.nexus'/.test(badging) ? ok('built APK package id correct') : bad('package id wrong');
    /uses-feature-not-required: name='android\.hardware\.touchscreen'/.test(badging) ? ok('built APK does not require a touchscreen') : bad('touchscreen still required in the APK');
  } catch (e) {
    note(`aapt2 introspection skipped: ${String(e.message).slice(0, 60)}`);
  }
}

(async () => {
  console.log('NexusEmu — deployment artefact verification');
  testDockerfile();
  testCompose();
  testNginx();
  testServerless();
  testInit();
  testApk();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();
