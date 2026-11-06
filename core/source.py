"""找「从绫开始」的数据库。

不调用对方的任何代码，只认文件：
  data/plugin_data/astrbot_plugin_congling/congling.db

优先级：配置里手填 > 按插件名推导 > 在 plugin_data 下扫一遍同名目录。
找不到不是错误——星图显示空星域就行，对方装好之后下一次请求自然会找到。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from astrbot.api import logger

TARGET_PLUGIN = "astrbot_plugin_congling"
DB_NAME = "congling.db"


class Source:
    def __init__(self, plugin: Any) -> None:
        self.plugin = plugin
        self.config = plugin.raw_config

    # ------------------------------------------------------------ 定位
    def _configured(self) -> Path | None:
        try:
            raw = str(self._cfg("db_path", "") or "").strip()
        except Exception:
            raw = ""
        if not raw:
            return None
        path = Path(raw)
        if path.is_dir():
            path = path / DB_NAME
        return path if path.is_file() else None

    def _cfg(self, key: str, default: Any) -> Any:
        config = self.config
        if config is None:
            return default
        try:
            return config.get(key, default)
        except Exception:
            try:
                return config[key]
            except Exception:
                return default

    def _derived(self) -> Path | None:
        """找库。

        最稳的一条：拿**自己**的数据目录，再往上退一级就是 plugin_data，
        这样完全不依赖 __file__ —— AstrBot 用相对路径加载插件时，
        Path(__file__).resolve() 会按 cwd 解析，落到一个根本不存在的地方。
        """
        # 1) 自己插件的数据目录 → 上一级 → 兄弟插件
        try:
            from astrbot.api.star import StarTools

            own = Path(str(StarTools.get_data_dir("astrbot_plugin_starmap")))
            db = own.parent / TARGET_PLUGIN / DB_NAME
            if db.is_file():
                return db
        except Exception as exc:
            logger.debug(f"[starmap] 由自身数据目录推导失败: {exc!r}")

        # 2) 官方 API 直接问对方的目录（不保证它装过，所以放第二条）
        try:
            from astrbot.api.star import StarTools

            db = Path(str(StarTools.get_data_dir(TARGET_PLUGIN))) / DB_NAME
            if db.is_file():
                return db
        except Exception as exc:
            logger.debug(f"[starmap] StarTools 解析失败: {exc!r}")

        # 3) 按文件位置推导
        here = Path(__file__).resolve()
        plugins_dir = here.parent.parent.parent
        data_dir = plugins_dir.parent
        for candidate in (
            data_dir / "plugin_data" / TARGET_PLUGIN / DB_NAME,
            plugins_dir / TARGET_PLUGIN / "data" / DB_NAME,
        ):
            if candidate.is_file():
                return candidate

        # 4) 兜底：在 plugin_data 里扫一遍，容忍目录改名
        base = data_dir / "plugin_data"
        if base.is_dir():
            for folder in base.iterdir():
                if folder.is_dir() and TARGET_PLUGIN in folder.name:
                    db = folder / DB_NAME
                    if db.is_file():
                        return db
        return None

    def candidates(self) -> list[str]:
        """所有试过的路径，排查时直接看这个。"""
        out: list[str] = []
        try:
            from astrbot.api.star import StarTools

            out.append(str(Path(str(StarTools.get_data_dir(TARGET_PLUGIN))) / DB_NAME))
        except Exception:
            out.append("(StarTools 不可用)")
        here = Path(__file__).resolve()
        plugins_dir = here.parent.parent.parent
        out.append(str(plugins_dir.parent / "plugin_data" / TARGET_PLUGIN / DB_NAME))
        return out

    def db_path(self) -> Path | None:
        return self._bound() or self._configured() or self._derived()

    # ------------------------------------------------------------ 手动绑定
    def _bind_file(self) -> Path:
        """绑定记录放本插件自己的数据目录，不碰 AstrBot 的配置文件。"""
        from astrbot.api.star import StarTools

        own = Path(str(StarTools.get_data_dir("astrbot_plugin_starmap")))
        return own / "bind.json"

    def _bound(self) -> Path | None:
        try:
            import json

            data = json.loads(self._bind_file().read_text("utf-8"))
            path = Path(str(data.get("db_path") or ""))
            return path if path.is_file() else None
        except Exception:
            return None

    def scan(self, raw: str) -> dict[str, Any]:
        """只校验，不保存。"""
        text = str(raw or "").strip().strip('"').strip("'")
        if not text:
            return {"ok": False, "reason": "路径是空的"}
        path = Path(text)
        if path.is_dir():
            path = path / DB_NAME
        if not path.is_file():
            return {"ok": False, "reason": f"这里没有 {DB_NAME}"}
        try:
            import sqlite3

            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
            try:
                has_table = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='mem_atom'"
                ).fetchone()
                if not has_table:
                    return {"ok": False, "reason": "这个库没有 mem_atom 表，不像是记忆库"}
                row = conn.execute(
                    "SELECT COUNT(*) FROM mem_atom WHERE status IN ('active','archived')"
                ).fetchone()
                total = int(row[0] or 0)
                sessions = conn.execute(
                    "SELECT COUNT(DISTINCT session_id) FROM mem_atom"
                ).fetchone()
            finally:
                conn.close()
        except Exception as exc:
            return {"ok": False, "reason": f"读不了这个库：{exc!r}"[:160]}
        return {
            "ok": True,
            "path": str(path),
            "count": total,
            "sessions": int(sessions[0] or 0) if sessions else 0,
        }

    def bind(self, raw: str) -> dict[str, Any]:
        """校验通过后记下来，下次启动直接用它。"""
        result = self.scan(raw)
        if not result.get("ok"):
            return result
        try:
            import json
            import time as _t

            target = self._bind_file()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps({"db_path": result["path"], "at": int(_t.time())}, ensure_ascii=False),
                "utf-8",
            )
        except Exception as exc:
            return {"ok": False, "reason": f"绑定记录写不进去：{exc!r}"[:160]}
        logger.info(f"[starmap] 已绑定记忆库：{result['path']}")
        return result

    def unbind(self) -> None:
        try:
            self._bind_file().unlink(missing_ok=True)
        except Exception:
            pass

    def status(self) -> dict[str, Any]:
        path = self.db_path()
        return {
            "found": path is not None,
            "path": str(path) if path else "",
            "target": TARGET_PLUGIN,
            "tried": self.candidates(),
            "configured": bool(str(self._cfg("db_path", "") or "").strip()),
        }

    # ------------------------------------------------------------ 读取
    def connect(self):
        """只读连接。对方正在写也不影响（WAL / 只读模式）。"""
        path = self.db_path()
        if path is None:
            raise FileNotFoundError("找不到 congling.db")
        import sqlite3

        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def table_exists(self, conn, name: str) -> bool:
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            return row is not None
        except Exception:
            return False

    def columns(self, conn, table: str) -> set[str]:
        try:
            return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        except Exception:
            logger.debug(f"[starmap] 读 {table} 结构失败")
            return set()
