"""星图的本地小服务。

为什么不只靠 AstrBot 面板：
面板的插件页面要求 asset_token（JWT），手输地址必定 401，而 token 只有面板自己知道。
用户要的是「点开就能看」，所以插件自己起一个只绑 127.0.0.1 的小服务：

    http://127.0.0.1:6186/       星图页面
    http://127.0.0.1:6186/data   同源接口，实时读库

不鉴权（只监听本机），不开 CORS（同源），端口可配。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from astrbot.api import logger

DEFAULT_PORT = 6186
PAGES_DIR = Path(__file__).resolve().parent.parent / "pages" / "starmap"


class LocalServer:
    def __init__(self, plugin: Any) -> None:
        self.plugin = plugin
        self.config = plugin.raw_config
        self.port = DEFAULT_PORT
        self._runner = None
        self._task = None

    def _cfg_port(self) -> int:
        try:
            raw = self.config.get("port", DEFAULT_PORT) if self.config else DEFAULT_PORT
            return max(1024, min(65535, int(raw)))
        except Exception:
            return DEFAULT_PORT

    async def start(self) -> None:
        self.port = self._cfg_port()
        try:
            from aiohttp import web
        except Exception as exc:
            logger.warning(f"[starmap] 没有 aiohttp，本地服务起不来: {exc!r}")
            return
        if not PAGES_DIR.is_dir():
            logger.warning(f"[starmap] 页面目录不存在: {PAGES_DIR}")
            return

        page_api = self.plugin.page_api

        async def data(_req):
            payload = await page_api.data()
            return web.json_response(payload)

        async def scan(req):
            try:
                body = await req.json()
            except Exception:
                body = {}
            payload = await page_api.scan_from(str((body or {}).get("path") or ""))
            return web.json_response(payload)

        async def bind(req):
            try:
                body = await req.json()
            except Exception:
                body = {}
            payload = await page_api.bind_from(str((body or {}).get("path") or ""))
            return web.json_response(payload)

        async def status(_req):
            return web.json_response(await page_api.status())

        async def index(_req):
            return web.FileResponse(PAGES_DIR / "index.html")

        app = web.Application()
        app.router.add_get("/data", data)
        app.router.add_get("/status", status)
        app.router.add_post("/scan", scan)
        app.router.add_post("/bind", bind)
        # 显式给 / 返回 index.html：add_static 只会列目录
        app.router.add_get("/", index)
        # 静态放最后，免得把上面的路由吃掉
        app.router.add_static("/", PAGES_DIR, show_index=False)

        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", self.port)
        try:
            await site.start()
        except OSError as exc:
            logger.warning(f"[starmap] 端口 {self.port} 起不来（可能被占用）: {exc!r}")
            try:
                await runner.cleanup()
            except Exception:
                pass
            return
        self._runner = runner
        logger.info(f"[starmap] 本地服务已启动：http://127.0.0.1:{self.port}/")

    async def stop(self) -> None:
        if self._runner is not None:
            try:
                await self._runner.cleanup()
            except Exception:
                pass
            self._runner = None
