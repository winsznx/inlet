#!/bin/sh
set -eu
. "$(dirname "$0")/lib.sh"

runtime="${SANDBOX_RUNTIME:-runsc}"
image="${SANDBOX_BROWSER_IMAGE:-inlet-runner-browser:local}"
echo "Probing runtime $runtime with $image on the sandbox network."
[ -e /dev/kvm ] && echo "/dev/kvm present" || echo "/dev/kvm absent"
if [ "$APPLY" = "1" ]; then
  docker run --rm --runtime "$runtime" --read-only --cap-drop ALL --security-opt no-new-privileges --network none --tmpfs /tmp "$image" node -e "console.log('runtime ok', process.version)"
  if docker run --rm --runtime "$runtime" --read-only --cap-drop ALL --security-opt no-new-privileges --network inlet-sandbox --dns 127.0.0.1 --tmpfs /tmp "$image" node -e "require('net').connect({host:'1.1.1.1',port:443}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(3)); setTimeout(()=>process.exit(3),5000)"; then
    echo "FAIL: the sandbox network reached the internet."
    exit 1
  fi
  echo "Direct egress denied on the sandbox network."
  if docker run --rm --runtime "$runtime" --memory 64m --memory-swap 64m --pids-limit 32 --network none --tmpfs /tmp "$image" node -e "const a=[];for(;;)a.push(Buffer.alloc(8e6,1))"; then
    echo "FAIL: the memory limit did not stop the process."
    exit 1
  fi
  echo "Memory limit enforced."
fi
finish_note
