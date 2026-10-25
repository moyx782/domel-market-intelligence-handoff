# 团队开发

1. Clone 仓库，运行 npm.cmd ci。
2. 每人使用自己的 .env。优先使用独立开发 Supabase 项目；不要复制生产服务端密钥。
3. 开始前 git switch main，然后 git pull；创建分支，例如 git switch -c feature/source-settings。
4. 小步提交，push 自己的分支，在 GitHub 创建 Pull Request。说明改了什么、怎么验证、哪些仍待验收。
5. 合并前运行 npm.cmd test 和 npm.cmd run build，至少请一位组员复核。
6. 共享模块、数据库迁移和认证设置先在 Issue 中协调，避免同时修改同一处。已有数据库不要重跑初始建表脚本。
7. 不提交 .env、密码、Key、令牌、node_modules、个人日志/学号邮箱或带账号信息的截图。

建议分工：表单、数据源页、后端检索、认证测试、审核流程、报告、界面适配、集成验证。分工以真实认领为准，不把共享代码当成个人历史贡献。
