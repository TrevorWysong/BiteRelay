#!/bin/sh
# The issuer container: starts its conductor, then
#   key    -- prints the issuer's agent key, for the network's roster;
#   serve  -- installs the network's hApp (once) and runs the issuer service.
set -eu
node scripts/conductor.mjs &
conductor=$!
trap 'kill $conductor 2>/dev/null' EXIT INT TERM

# Wait for the admin interface.
for _ in $(seq 1 60); do
  if node -e "require('net').connect(8870,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then break; fi
  sleep 1
done

case "${1:-serve}" in
  key)
    node scripts/provision.mjs key
    ;;
  serve)
    node scripts/provision.mjs install /app/relay.happ
    exec npm start
    ;;
  *)
    echo "usage: key | serve" >&2
    exit 2
    ;;
esac
