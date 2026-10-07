import json
import os
import pathlib
import sys

key = os.environ.get("DEEPSEEK_API_KEY", "")
if not key:
    sys.exit("DEEPSEEK_API_KEY secret is empty")

path = pathlib.Path("js/ai.js")
text = path.read_text()
needle = 'apiKey: ""'
if needle not in text:
    sys.exit("apiKey placeholder missing in js/ai.js")
path.write_text(text.replace(needle, "apiKey: " + json.dumps(key), 1))
