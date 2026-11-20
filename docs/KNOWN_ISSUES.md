# 已知问题与排查记录（Known Issues）

记录在搭建 **Linux 云服务器（DSH + DS-Bot）+ `dsh-Go`（SSH 遥控）** 过程中定位到的问题、根因所在层及解决方案。

---

## 1. Anthropic 兼容端点点击「获取模型」报 `找不到模型列表，检查 Base URL`

- **所属层级**：上游 API 协议层 + `dsh-Go` 客户端报错映射层
- **现象**：填写正确的 Anthropic 兼容 Base URL 和 API Key 后，点击「获取模型」提示 `找不到模型列表，检查 Base URL`。
- **根因**：
  1. 许多 Anthropic 兼容端点（如 DeepSeek `/anthropic` 及多数中转站）只实现了对话接口 `/v1/messages`，未实现 `GET /v1/models`，导致服务端返回 `HTTP 404`。
  2. `dsh-Go` 的 [`providers_state.dart`](../../dsh-Go/app/lib/state/providers_state.dart#L423) 将所有 `404` 统一映射为 `stateProviderModelsMissing`（“找不到模型列表，检查 Base URL”），未提示改用「手动添加」。
- **临时方案**：跳过「获取模型」，直接点模型卡片最下方的 **「手动添加」** 填入模型 ID 并保存。
- **上游 Issue**：[`ccch1mneyyy/dsh-Go#1607`](https://github.com/ccch1mneyyy/dsh-Go/issues/1607)

---

## 2. 保存自定义渠道时提示 `没能保存：没能完成，再试一次`

- **所属层级**：DSH 服务端配置层（Home Patch 保护机制）+ `dsh-Go` 报错映射层
- **现象**：手动添加模型后点「保存」，客户端弹出 `没能保存：没能完成，再试一次`。
- **根因**：
  1. 服务端 `$DSH_HOME/cordis.patch.yml`（压测遗留文件）硬编码了 `- id: llm-pi-ai` 和 `- id: agent-default-model`。DSH 的 `settings/mutate` 规则规定：被 home patch 覆盖的配置节拒绝客户端写入（见 [`features_api.dart`](../../dsh-Go/packages/dsh_client/lib/src/features_api.dart#L646-L648)）。
  2. `dsh-Go` 的 [`providers_state.dart`](../../dsh-Go/app/lib/state/providers_state.dart#L440) 未对该服务端拒绝错误做单独映射，兜底返回 `commonFailedTryAgain`。
- **服务端解决**：将 `$DSH_HOME/cordis.patch.yml` 备份为 `cordis.patch.yml.lab-bak`（`profiles/web/cordis.patch.yml` 同步备份并重置为 `[]`），重启 `ds-bot.service`。
- **上游 Issue**：[`ccch1mneyyy/dsh-Go#1607`](https://github.com/ccch1mneyyy/dsh-Go/issues/1607)

---

## 3. `dsh-Go` 切换兼容协议时 Base URL 不会联动适配

- **所属层级**：`dsh-Go` 客户端表单交互层
- **现象**：在添加/编辑自定义模型渠道页面切换兼容协议（`OpenAI` / `Anthropic` / `Responses`）时，仅更新了 `_api` 和 `hintText`，已填的 `Base URL` 保持原样（如末尾 `/v1` 未去掉、已知端点未联动），需手动修改。
- **根因**：[`provider_form_page.dart`](../../dsh-Go/app/lib/ui/providers/provider_form_page.dart#L387-L391) 中 `SegmentedPill<ProviderApi>.onChanged` 仅调用 `setState(() => _api = v)`。
- **上游 Issue**：[`ccch1mneyyy/dsh-Go#1608`](https://github.com/ccch1mneyyy/dsh-Go/issues/1608)
