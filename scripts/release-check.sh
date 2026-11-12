#!/bin/zsh
# Build, test, package, real VS Code gate and staging for Format XML & XPath Tools.
# Refuses to start when free disk < 20 GB or free memory < 25% (~/.claude/CLAUDE.md).
# usage: scripts/release-check.sh [stageDir]   (default: wave13/out/BUILD20-dist)
set -eu
here=${0:A:h}; repo=${here:h}
stage=${1:-$HOME/plugin-market-intel-work/run-20261107/wave13/out/BUILD20-dist}
work=$HOME/xml-tools-work
port=9264
avail=$(df -g /System/Volumes/Data | tail -1 | awk '{print $4}')
mem=$(memory_pressure | tail -1 | grep -o '[0-9]*%' | tr -d %)
echo "free disk ${avail} GB, free memory ${mem}%"
if (( avail < 20 )); then echo "STOP: free disk ${avail} GB < 20 GB (CLAUDE.md). Nothing started."; exit 3; fi
if (( mem < 25 )); then echo "STOP: free memory ${mem}% < 25%. Nothing started."; exit 3; fi
if curl -s -m 2 http://127.0.0.1:$port/json/version >/dev/null 2>&1; then echo "STOP: port $port already answers"; exit 3; fi
cd $repo
BUILDSLOT_MIN_FREE_GB=20 ~/bin/buildslot node scripts/build.js
REAL_DIR=$work/gate/real BUILDSLOT_MIN_FREE_GB=20 ~/bin/buildslot timeout 900 node --test test/*.test.js > $work/unit.log 2>&1 || { tail -40 $work/unit.log; exit 1; }
grep -E '^# (tests|pass|fail)' $work/unit.log || true
rm -f dist/*.vsix
BUILDSLOT_MIN_FREE_GB=20 ~/bin/buildslot npm run -s package
vsix=$(ls dist/*.vsix | head -1)
echo "vsix: $vsix ($(stat -f %z $vsix) bytes)"
# gate workspace: real files, samples, hostile files, big files (deleted after the gate)
ws=$work/gate/ws
mkdir -p $ws/real $ws/samples $ws/hostile $ws/big $work/gate/shots
cp $work/gate/real/* $ws/real/; cp samples/*.* $ws/samples/; cp samples/hostile/* $ws/hostile/
node scripts/make-samples.js $ws/big 49
for theme in dark light; do
  timeout 1500 node scripts/e2e-vscode.mjs $work/gate/vsc-$theme $port $vsix $ws $work/gate/shots $work/gate/report-$theme.json $theme || true
  # fresh files for the next run
  cp $work/gate/real/* $ws/real/; cp samples/*.* $ws/samples/; cp samples/hostile/* $ws/hostile/
  rm -f $ws/big/*.formatted.xml; node scripts/make-samples.js $ws/big 49 >/dev/null
done
rm -rf $ws/big $work/gate/vsc-dark $work/gate/vsc-light
node -e "for (const t of ['dark','light']) { const r = require('$work/gate/report-' + t + '.json'); const ok = r.steps.filter(s => s.ok).length; console.log(t, ok + '/' + r.steps.length, r.steps.filter(s => !s.ok).map(s => s.name).join('; ')); }"
mkdir -p $stage
cp $vsix $stage/
echo "staged $(basename $vsix) in $stage; sha256 $(shasum -a 256 $vsix | cut -d' ' -f1)"
