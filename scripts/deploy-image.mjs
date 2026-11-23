#!/usr/bin/env node
// Tested-image deploy for a static site (same pattern as the OpenApe web
// apps): package the dist dir into an amd64 Caddy image, smoke-test it,
// upload it into chatty's image store with `docker pussh`, then restart the
// container with a health gate and tag rollback.
//
//   node scripts/deploy-image.mjs
//
// Prereqs: `docker pussh` (see requirePussh), SSH access as openape and ubuntu.

import { execFileSync } from 'node:child_process'
import process from 'node:process'

// docker-pussh v0.4.3 hardcodes its unregistry image (0.4.1) and only honours
// UNREGISTRY_IMAGE. That container gets chatty's containerd socket, so pin it
// by digest (multi-arch index of 0.4.1), not just by a mutable tag.
const PUSSH_ENV = { ...process.env, UNREGISTRY_IMAGE: 'ghcr.io/psviderski/unregistry:0.4.1@sha256:7297f3bb6f503515991e81e249dab81c23d2c350323fc209e3eaa8507a5970b1' }

// `docker pussh --version|--help` exit 0 even without the plugin (docker
// answers them itself), so ask the CLI for its installed plugins.
function requirePussh() {
  let plugins = ''
  try { plugins = execFileSync('docker', ['info', '--format', '{{range .ClientInfo.Plugins}}{{.Name}} {{end}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch {}
  if (!plugins.split(' ').includes('pussh')) {
    throw new Error('`docker pussh` is not available. Install it with:\n'
      + '  brew install psviderski/tap/docker-pussh\n'
      + '  mkdir -p ~/.docker/cli-plugins && ln -sf "$(brew --prefix)/bin/docker-pussh" ~/.docker/cli-plugins/docker-pussh')
  }
}

// Remove local tags of one image repository except `keep`; never other images.
// Each failure only warns (in-use or already-missing tags stay as they are).
function cleanupScript(repo, keep) {
  const keepRefs = keep.filter(Boolean).map(tag => `"${repo}:${tag}"`).join('|')
  return `
      docker image ls --format '{{.Repository}}:{{.Tag}}' '${repo}' | while read -r ref; do
        case "$ref" in
          ${keepRefs}|*:'<none>') ;;
          *) docker image rm "$ref" >/dev/null || echo "WARN could not remove $ref" ;;
        esac
      done
    `
}

const SITE = {
  /** Directory to serve (build context of compose/site.Dockerfile). */
  dist: '.',
  /** Command to (re)build `dist`, or null for plain checked-in files. */
  build: null,
  image: 'site-website',
  compose: 'web',
  domain: 'openape.ai',
  envVar: 'WEBSITE_TAG',
  prodDir: '/home/openape/prod-site-website',
}

// Local image name prefix only (compose/chatty.yml references it).
const REGISTRY = 'registry.openape.ai'
const HOST = process.env.CHATTY_HOST || 'chatty.delta-mind.at'
const USER = process.env.CHATTY_USER || 'openape'
const PUSSH_TARGET = process.env.CHATTY_PUSSH || `ubuntu@${HOST}`

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}
function out(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}
function ssh(script) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', `${USER}@${HOST}`, 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
  }).trim()
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function smokeTest(tag) {
  const name = `smoke-${SITE.image}`
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }) }
  catch {}
  sh('docker', ['run', '-d', '--name', name, '--platform', 'linux/amd64', '-p', '127.0.0.1:18080:80', tag])
  try {
    for (let i = 0; i < 15; i++) {
      try {
        const res = await fetch('http://127.0.0.1:18080/')
        if (res.ok) return
      }
      catch {}
      await sleep(1000)
    }
    throw new Error('smoke test failed: / never returned 200 on :18080')
  }
  finally {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }) }
    catch {}
  }
}

async function externalHealth() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`https://${SITE.domain}/`, { signal: AbortSignal.timeout(8000) })
      if (res.ok) return true
    }
    catch {}
    await sleep(2000)
  }
  return false
}

requirePussh()
const sha = out('git', ['rev-parse', '--short', 'HEAD'])
const tag = `${REGISTRY}/${SITE.image}:prod-${sha}`
console.log(`━━━ ${SITE.image} → ${tag}`)

if (SITE.build) {
  console.log(`→ build: ${SITE.build.join(' ')}`)
  sh(SITE.build[0], SITE.build.slice(1))
}
console.log('→ package (amd64)')
sh('docker', ['buildx', 'build', '--platform', 'linux/amd64', '-f', 'compose/site.Dockerfile', '-t', tag, '--load', SITE.dist])
console.log('→ smoke test')
await smokeTest(tag)
console.log('→ pussh')
sh('docker', ['pussh', tag, PUSSH_TARGET], { env: PUSSH_ENV })

console.log('→ chatty: sync compose, pin tag, up')
ssh(`mkdir -p ${SITE.prodDir}`)
sh('scp', ['-q', 'compose/chatty.yml', `${USER}@${HOST}:${SITE.prodDir}/docker-compose.yml`])
const prev = ssh(`
  set -euo pipefail
  cd ${SITE.prodDir}
  touch .env
  OLD=$(grep -E '^${SITE.envVar}=' .env | cut -d= -f2- || true)
  grep -vE '^${SITE.envVar}(_PREV)?=' .env > .env.new || true
  if [ -n "$OLD" ]; then echo "${SITE.envVar}_PREV=$OLD" >> .env.new; fi
  echo "${SITE.envVar}=prod-${sha}" >> .env.new
  mv .env.new .env
  docker compose --env-file .env -f docker-compose.yml up -d --pull never ${SITE.compose}
  echo "$OLD"
`)

console.log(`→ health gate https://${SITE.domain}/`)
if (await externalHealth()) {
  console.log(`✓ deployed (prod-${sha}${prev ? `, prev ${prev}` : ''})`)
  try {
    const log = ssh(cleanupScript(`${REGISTRY}/${SITE.image}`, [`prod-${sha}`, prev]))
    if (log) console.warn(log)
  }
  catch (e) { console.warn(`⚠ image cleanup failed (deploy is healthy): ${e.message}`) }
}
else {
  console.error('✗ health gate failed — rolling back')
  if (prev) {
    ssh(`
      set -euo pipefail
      cd ${SITE.prodDir}
      grep -vE '^${SITE.envVar}=' .env > .env.new || true
      echo "${SITE.envVar}=${prev}" >> .env.new
      mv .env.new .env
      docker compose --env-file .env -f docker-compose.yml up -d ${SITE.compose}
    `)
    console.error(`→ rolled back to ${prev}`)
  }
  process.exit(1)
}
