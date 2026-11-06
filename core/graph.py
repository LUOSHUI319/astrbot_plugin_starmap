"""关联边算法。

逐行对译 star-map/scripts/build-data.js，参数一致：
  weight = 0.22*同会话 + 0.32*实体重合 + 0.30*二元词 Dice + 0.13*时间衰减 + 0.03*同类型
  阈值 0.38，每点最多连 K=7 条

已在 6200 条真实数据上对过答案（2026-11-07）：
  nodeCount 6200 / thresholdPairs 106456 / edgeCount 13800 / activeEdgeCount 5266，与 JS 版完全一致。
唯一差异是 candidatePairs 少了 1（localeCompare 与 Python 排序的细微顺序差），不影响任何一条边。

不要随手调权重：星图的视觉密度就是按这套参数调的。
"""

from __future__ import annotations

import json
import math
import re
import time
import unicodedata
from collections import defaultdict
from typing import Any

K = 7
THRESHOLD = 0.38
COMMON = {"用户", "机器", "器人", "聊天", "表示", "自己", "一个", "进行", "可以", "没有", "希望", "认为"}
W_SESSION, W_ENTITY, W_TEXT, W_TIME, W_KIND = 0.22, 0.32, 0.30, 0.13, 0.03
WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)

VISIBLE_STATUS = ("active", "archived")


# ------------------------------------------------------------------ 读取
def load_atoms(conn) -> list[dict[str, Any]]:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(mem_atom)")}
    if not cols:
        return []
    wanted = [
        "id", "kind", "text", "importance", "strength", "mem_level", "status",
        "session_id", "session_kind", "session_label", "subject_id", "subject_ref",
        "created_at", "last_hit_at", "hit_count", "level_tags",
    ]
    picked = [c for c in wanted if c in cols]
    sql = (
        f"SELECT {', '.join(picked)} FROM mem_atom "
        "WHERE status IN ('active','archived') ORDER BY id"
    )
    atoms: list[dict[str, Any]] = []
    for row in conn.execute(sql):
        data = dict(row)
        try:
            tags = json.loads(str(data.get("level_tags") or "[]"))
            if not isinstance(tags, list):
                tags = []
        except (TypeError, ValueError):
            tags = []
        subject = str(data.get("subject_id") or "")
        atoms.append({
            "id": int(data.get("id") or 0),
            "kind": str(data.get("kind") or "fact"),
            "level": int(data.get("mem_level") or 3),
            "importance": round(float(data.get("importance") or 0.5), 3),
            "strength": round(float(data.get("strength") or 0.65), 3),
            "text": str(data.get("text") or ""),
            "session": str(data.get("session_label") or data.get("session_id") or ""),
            "session_kind": str(data.get("session_kind") or ""),
            "created": int(data.get("created_at") or 0),
            "last_hit": int(data.get("last_hit_at") or 0),
            "hits": int(data.get("hit_count") or 0),
            "status": str(data.get("status") or "active"),
            "tags": [str(t)[:24] for t in tags][:8],
            "subject": subject,
            "ent": [{"k": subject, "r": "subject"}] if subject else [],
        })
    return atoms


def snapshot_marker(conn) -> tuple[int, int]:
    """用来判断数据有没有变：条数 + 最大 id。"""
    try:
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(id),0) FROM mem_atom WHERE status IN ('active','archived')"
        ).fetchone()
        return int(row[0] or 0), int(row[1] or 0)
    except Exception:
        return 0, 0


# ------------------------------------------------------------------ 算法
def _grams(text: str) -> set[str]:
    s = unicodedata.normalize("NFKC", str(text or "")).lower()
    out: set[str] = set()
    for part in WORD_RE.findall(s):
        chars = list(part)
        for j in range(len(chars) - 1):
            gram = chars[j] + chars[j + 1]
            if gram not in COMMON:
                out.add(gram)
    return out


def _overlap(a: set[str], b: set[str]) -> int:
    if len(a) > len(b):
        a, b = b, a
    return sum(1 for x in a if x in b)


def build_graph(atoms: list[dict[str, Any]]) -> dict[str, Any]:
    nodes = [n for n in atoms if n.get("status") in VISIBLE_STATUS]
    total = len(nodes)
    if total == 0:
        return {"atoms": atoms, "edges": [], "graph": _graph_meta(0, 0, 0, 0, 0, atoms)}

    sessions: dict[str, list[int]] = defaultdict(list)
    entities: dict[str, list[int]] = defaultdict(list)
    postings: dict[str, list[int]] = defaultdict(list)

    gram_sets = [_grams(n.get("text")) for n in nodes]
    tag_sets: list[set[str]] = []
    for n in nodes:
        tags: set[str] = set()
        for e in (n.get("ent") or []):
            tags.add("实体:" + str(e.get("k")))
        for t in (n.get("tags") or []):
            tags.add("标签:" + str(t).strip().strip("'\""))
        tag_sets.append(tags)

    for i, n in enumerate(nodes):
        if n.get("session"):
            sessions[n["session"]].append(i)
        for tag in tag_sets[i]:
            entities[tag].append(i)
        for gram in gram_sets[i]:
            postings[gram].append(i)

    def chronological(i: int) -> tuple[int, int]:
        return int(nodes[i].get("created") or 0), int(nodes[i].get("id") or 0)

    candidates: set[int] = set()

    def pair(a: int, b: int) -> None:
        if a != b:
            candidates.add(min(a, b) * total + max(a, b))

    def nearby(lst: list[int], radius: int) -> None:
        lst.sort(key=chronological)
        for i in range(len(lst)):
            for j in range(i + 1, min(i + radius, len(lst) - 1) + 1):
                pair(lst[i], lst[j])

    for lst in sessions.values():
        nearby(lst, 12)
    for lst in entities.values():
        nearby(lst, 8)
    nearby(list(range(total)), 4)

    rare: dict[str, list[int]] = {}
    for gram, lst in postings.items():
        if 2 <= len(lst) <= 203:
            rare[gram] = sorted(lst, key=chronological)

    for i in range(total):
        selected = [g for g in gram_sets[i] if g in rare]
        selected.sort(key=lambda g: (len(rare[g]), g))
        for gram in selected[:12]:
            lst = rare[gram]
            pos = lst.index(i)
            for j in range(max(0, pos - 4), min(len(lst) - 1, pos + 4) + 1):
                pair(i, lst[j])

    neighbors: list[list[dict[str, Any]]] = [[] for _ in range(total)]
    passed = 0
    exp_neg1 = math.exp(-1)
    for key in candidates:
        a, b = divmod(key, total)
        same_session = bool(nodes[a].get("session")) and nodes[a].get("session") == nodes[b].get("session")
        shared_tags = _overlap(tag_sets[a], tag_sets[b])
        entity = shared_tags / max(1, min(len(tag_sets[a]), len(tag_sets[b])))
        shared_grams = _overlap(gram_sets[a], gram_sets[b])
        text_score = 2 * shared_grams / max(1, len(gram_sets[a]) + len(gram_sets[b]))
        dt = abs(int(nodes[a].get("created") or 0) - int(nodes[b].get("created") or 0))
        time_score = math.exp(-dt / (18 * 3600))
        same_kind = nodes[a].get("kind") == nodes[b].get("kind")
        weight = (
            W_SESSION * (1 if same_session else 0)
            + W_ENTITY * entity
            + W_TEXT * text_score
            + W_TIME * time_score
            + W_KIND * (1 if same_kind else 0)
        )
        if weight < THRESHOLD:
            continue
        mask = (
            (1 if same_session else 0)
            | (2 if shared_tags else 0)
            | (4 if shared_grams else 0)
            | (8 if time_score >= exp_neg1 else 0)
            | (16 if same_kind else 0)
        )
        edge = {"a": a, "b": b, "weight": weight, "mask": mask}
        neighbors[a].append(edge)
        neighbors[b].append(edge)
        passed += 1

    tops: list[dict[tuple[int, int], dict[str, Any]]] = []
    for i, lst in enumerate(neighbors):
        def key_fn(e: dict[str, Any], i: int = i) -> tuple[float, int]:
            other = e["b"] if e["a"] == i else e["a"]
            return -e["weight"], int(nodes[other].get("id") or 0)

        ordered = sorted(lst, key=key_fn)[:K]
        tops.append({(e["a"], e["b"]): e for e in ordered})

    edges: list[list[Any]] = []
    for a in range(total):
        for edge in tops[a].values():
            if edge["a"] == a and (edge["a"], edge["b"]) in tops[edge["b"]]:
                edges.append([
                    int(nodes[edge["a"]].get("id")),
                    int(nodes[edge["b"]].get("id")),
                    round(edge["weight"], 5),
                    edge["mask"],
                ])
    edges.sort(key=lambda x: (x[0], x[1]))

    counts: dict[str, int] = {}
    for n in atoms:
        status = str(n.get("status") or "")
        counts[status] = counts.get(status, 0) + 1
    by_id = {int(n.get("id")): n for n in nodes}
    active_edges = sum(
        1 for e in edges
        if by_id[e[0]].get("status") == "active" and by_id[e[1]].get("status") == "active"
    )
    return {
        "atoms": atoms,
        "edges": edges,
        "graph": _graph_meta(total, len(candidates), passed, len(edges), active_edges, atoms, counts),
    }


def _graph_meta(
    nodes: int,
    candidates: int,
    passed: int,
    edges: int,
    active_edges: int,
    atoms: list[dict[str, Any]],
    counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    if counts is None:
        counts = {}
        for n in atoms:
            status = str(n.get("status") or "")
            counts[status] = counts.get(status, 0) + 1
    return {
        "version": 1,
        "topK": K,
        "threshold": THRESHOLD,
        "candidatePairs": candidates,
        "thresholdPairs": passed,
        "nodeCount": nodes,
        "edgeCount": edges,
        "activeEdgeCount": active_edges,
        "counts": counts,
        "weights": {"session": W_SESSION, "entity": W_ENTITY, "bigramDice": W_TEXT, "time": W_TIME, "kind": W_KIND},
    }


# ------------------------------------------------------------------ 缓存
class GraphCache:
    """按「条数 + 最大 id」判断失效，TTL 兜底 60 秒。

    全量重算约 2 秒，不能每次请求都跑；但也不能缓存太久 —— 刚聊完就想看星图是常态。
    """

    def __init__(self, ttl: float = 60.0) -> None:
        self.ttl = ttl
        self._at = 0.0
        self._marker: tuple[int, int] = (-1, -1)
        self._data: dict[str, Any] | None = None
        self._lock = None

    async def get(self, conn) -> dict[str, Any]:
        import asyncio

        if self._lock is None:
            self._lock = asyncio.Lock()
        marker = snapshot_marker(conn)
        fresh = self._data is not None and marker == self._marker and (time.time() - self._at) < self.ttl
        if fresh:
            return self._data
        async with self._lock:
            marker = snapshot_marker(conn)
            if self._data is not None and marker == self._marker and (time.time() - self._at) < self.ttl:
                return self._data
            atoms = load_atoms(conn)
            built = await asyncio.to_thread(build_graph, atoms)
            self._data = built
            self._marker = marker
            self._at = time.time()
            return built
