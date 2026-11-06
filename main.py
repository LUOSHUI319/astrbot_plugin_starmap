"""记忆星图 · 插件入口。

只做三件事：
1. 找到「从绫开始」的数据库（只读打开，不需要对方安装或配合）；
2. 把原子记忆 + 关联边算成一份 JSON（算法与 star-map/scripts/build-data.js 逐项对齐）；
3. 把星图页面挂到面板上。

设计取舍：
- 不跨插件调实例。`context.get_registered_star(...).star_cls` 依赖加载顺序和私有属性，
  换个版本就散架；直读 sqlite 反而稳，而且 congling 没启动也能用。
- 关联边在 Python 里算完再发给前端。浏览器算 6200 节点的两两相似度会白屏好几秒。
"""

from __future__ import annotations

from astrbot.api import AstrBotConfig, logger
from astrbot.api.star import Context, Star, register

from .core.local_server import LocalServer
from .core.source import Source
from .page_api import PageApi

PLUGIN_VERSION = "0.1.0"


@register(
    "astrbot_plugin_starmap",
    "洛水 & 望山",
    "记忆星图：把从绫开始的记忆画成星图",
    PLUGIN_VERSION,
)
class StarMapPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None) -> None:
        super().__init__(context)
        self.raw_config = config
        self.source = Source(self)
        self.page_api = PageApi(self)
        self.server = LocalServer(self)
        self._server_task = None
        try:
            self.page_api.register_routes()
        except Exception as exc:
            logger.warning(f"[starmap] 路由注册失败: {exc!r}")
        logger.info(f"[starmap] 已启动，数据库={'找到' if self.source.db_path() else '没找到'}")

    async def initialize(self) -> None:
        """起本地小服务：面板页面要 token，手输打不开，所以自己开一个。"""
        import asyncio

        try:
            self._server_task = asyncio.create_task(self.server.start())
        except Exception as exc:
            logger.warning(f"[starmap] 本地服务启动失败: {exc!r}")

    async def terminate(self) -> None:
        try:
            await self.server.stop()
        except Exception:
            pass
