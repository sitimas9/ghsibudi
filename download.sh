#!/data/data/com.termux/files/usr/bin/bash
# Download farm files from GitHub (private repo, auth via token header)
TOKEN="YOUR_GITHUB_TOKEN"
BASE="https://api.github.com/repos/sitimas9/scriptbox/contents"

download() {
  local file=$1
  local out=$2
  echo -n "  $file ... "
  curl -s -H "Authorization: Bearer $TOKEN" "$BASE/$file" | \
    python3 -c "import sys,json,base64; d=json.load(sys.stdin); print(base64.b64decode(d['content']).decode(), end='')" > "$out"
  echo "OK ($(wc -l < $out) lines)"
}

echo "=== Downloading farm files ==="
download signup_worker.py ~/signup_worker.py
download mail_list.txt ~/mail_list.txt
download token_collector.py ~/token_collector.py
chmod +x ~/signup_worker.py
echo ""
echo "=== Done! ==="
echo "Test IP:  curl -s https://api.ipify.org"
echo "Run farm: python3 ~/signup_worker.py"