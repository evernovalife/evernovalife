# tools/emit_seedance_prompts.py  — run from the repo root
import re, pathlib

DOC = pathlib.Path('docs/seedance-vial-prompts.md').read_text(encoding='utf-8')
OUT = pathlib.Path('assets/video/_seed'); OUT.mkdir(parents=True, exist_ok=True)

# the prompt body is the fenced block containing the fixed-label clause.
# Anchor the fences to line starts and allow a language tag, or the opening and
# closing fences interleave and every capture comes out shifted by one block.
body = next(b.strip('\n') for b in re.findall(r'^```[a-z]*\n(.*?)^```', DOC, re.S | re.M)
            if 'THE LABEL TEXT IS FIXED' in b)

# the label lines are the backticked cells of the Step 4 table
rows = re.findall(r'^\|\s*(\d)\s*\|[^|]+\|\s*`(.+?)`\s*\|\s*$', DOC, re.M)
assert len(rows) == 8, f'expected 8 label lines, found {len(rows)}'

for pid, label in rows:
    text = body.replace('<<<paste the line from the Step 4 table here>>>',
                        label.replace(r'\|', '|'))
    assert '<<<' not in text
    (OUT / f'prompt-{pid}.txt').write_text(text, encoding='utf-8')
    print(f'prompt-{pid}.txt  {len(text)} chars')
