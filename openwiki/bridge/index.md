# 文件

- [脚本库本机备份与恢复](library-backup.md) - 桥接如何把扩展里的脚本按浏览器资料同步到 ~/.page-recorder/library/，文件格式、脱敏、归属和删除规则，以及卸载或换目录重装扩展后如何恢复脚本。
- [MCP 工具与结果处理](mcp-tools-and-results.md) - 桥接如何把脚本库暴露成固定工具和动态接口工具，脚本库变大时如何按需查找，以及大结果如何压缩、缓存并通过 read_result 读取。
- [桥接服务生命周期与连接](server-lifecycle.md) - 桥接的 HTTP、stdio、后台 daemon 三种运行方式，扩展 WebSocket 连接和能力声明、连接后的同步与更新调度、多浏览器路由、实例间转发、自动退出机制，以及常见连接故障的判断方法。
