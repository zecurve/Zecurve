#!/bin/bash
# Usage: ./export-key.sh <address> <output-filename>
# Example: ./export-key.sh t1abc... my-key.txt

ADDRESS="$1"
OUTFILE="${2:-exported-key.txt}"

if [ -z "$ADDRESS" ]; then
  echo "Usage: ./export-key.sh <address> [output-filename]"
  exit 1
fi

zcash-cli dumpprivkey "$ADDRESS" > "$OUTFILE"
echo "Wrote key to $OUTFILE"
cat "$OUTFILE"
