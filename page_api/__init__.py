"""记忆星图的数据接口。

只提供两个只读接口：
  GET /data    原子记忆 + 关联边 + 图元信息（结构与原 memory-data.js 的 MEMORY_DATA 一致）
  GET /status  数据库找没找到、上次构建用了多久

不提供写接口。星图是观测站，不是编辑器 —— 想改记忆回「从绫开始」的面板。
"""

from __future__ import annotations

import time
from typing import Any

from astrbot.api import logger

from ..core.graph import GraphCache


def _ok(data: Any = None) -> dict[str, Any]:
    return {"status": "ok", "ok": True, "data": data, "ts": int(time.time())}


def _err(message: str) -> dict[str, Any]:
    return {
        "status": "error",
        "ok": False,
        "message": message,
        "error": message,
        "data": {},
        "ts": int(time.time()),
    }


class PageApi:
    def __init__(self, plugin: Any) -> None:
        self.plugin = plugin
        self.source = plugin.source
        self.cache = GraphCache()
        self._last_build_ms = 0

    def register_routes(self) -> None:
        register = self.plugin.context.register_web_api
        register("/data", self.data, ["GET"])
        register("/status", self.status, ["GET"])
        register("/refresh", self.refresh, ["POST"])
        register("/scan", self.scan, ["POST"])
        register("/bind", self.bind, ["POST"])

    async def _body(self) -> dict[str, Any]:
        from astrbot.api.web import request

        try:
            payload = await request.json(default={})
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    async def scan(self) -> dict[str, Any]:
        try:
            body = await self._body()
            return await self.scan_from(str(body.get("path") or ""))
        except Exception as exc:
            return _err(repr(exc)[:200])

    async def bind(self) -> dict[str, Any]:
        try:
            body = await self._body()
            return await self.bind_from(str(body.get("path") or ""))
        except Exception as exc:
            return _err(repr(exc)[:200])

    async def scan_from(self, path: str) -> dict[str, Any]:
        """不依赖 astrbot.request 的版本，本地小服务也用它。"""
        try:
            result = self.source.scan(path)
            return _ok(result) if result.get("ok") else _err(str(result.get("reason") or "扫描失败"))
        except Exception as exc:
            return _err(repr(exc)[:200])

    async def bind_from(self, path: str) -> dict[str, Any]:
        try:
            result = self.source.bind(path)
            if not result.get("ok"):
                return _err(str(result.get("reason") or "绑定失败"))
            self.cache._data = None
            self.cache._marker = (-1, -1)
            return _ok(result)
        except Exception as exc:
            return _err(repr(exc)[:200])

    async def data(self) -> dict[str, Any]:
        try:
            conn = self.source.connect()
        except FileNotFoundError:
            # 没装从绫开始不是错误：给空星域，页面自己能解释
            return _ok({
                "exported_at": int(time.time()),
                "count": 0,
                "atoms": [],
                "edges": [],
                "graph": {"version": 1, "nodeCount": 0, "edgeCount": 0, "counts": {}},
                "missing": True,
            })
        except Exception as exc:
            logger.warning(f"[starmap] 打不开数据库: {exc!r}")
            return _err(repr(exc)[:200])
        try:
            started = time.perf_counter()
            built = await self.cache.get(conn)
            self._last_build_ms = int((time.perf_counter() - started) * 1000)
            payload = {
                "exported_at": int(time.time()),
                "count": len(built.get("atoms") or []),
                "atoms": built.get("atoms") or [],
                "edges": built.get("edges") or [],
                "graph": built.get("graph") or {},
                "missing": False,
            }
            return _ok(payload)
        except Exception as exc:
            logger.warning(f"[starmap] 构建星图失败: {exc!r}")
            return _err(repr(exc)[:200])
        finally:
            try:
                conn.close()
            except Exception:
                pass

    async def refresh(self) -> dict[str, Any]:
        """强制重算（忽略缓存）。"""
        try:
            conn = self.source.connect()
        except FileNotFoundError:
            return _err("找不到 congling 的数据库")
        try:
            from ..core.graph import build_graph, load_atoms

            atoms = load_atoms(conn)
            built = await __import__("asyncio").to_thread(build_graph, atoms)
            self.cache._data = built
            self.cache._marker = (-1, -1)
            self.cache._at = time.time()
            return _ok({"count": len(atoms), "graph": built.get("graph") or {}})
        except Exception as exc:
            return _err(repr(exc)[:200])
        finally:
            try:
                conn.close()
            except Exception:
                pass

    async def status(self) -> dict[str, Any]:
        info = self.source.status()
        info["build_ms"] = self._last_build_ms
        info["cached"] = self.cache._data is not None
        return _ok(info)
