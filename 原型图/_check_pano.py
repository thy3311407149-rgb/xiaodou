# -*- coding: utf-8 -*-
from pathlib import Path
path = Path(r"d:\项目文件\原型图\底层架构图.html")
t = path.read_text(encoding="utf-8")
old_css_start = "  /* 舞台：垂直居中，光晕在堆叠层外扩 */"
old_css_end = "  /* 详情抽屉仍复用这些样式 */"
i = t.find(old_css_start)
j = t.find(old_css_end)
assert i != -1 and j != -1, (i, j)
print("css", i, j)
old_js_start = "  function cardInnerHtml(card, index) {"
old_js_end = "  function renderPanorama(asRefresh) {"
ii = t.find(old_js_start)
jj = t.find(old_js_end)
assert ii != -1 and jj != -1, (ii, jj)
print("js", ii, jj)
