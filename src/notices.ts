import type {Lang} from './i18n';

// Research coverage notices are produced and stored by the backend in English.
// They are translated at render time so switching the interface language also
// re-renders historical notices, without rewriting stored data.

const exact:Record<string,string>={
 'Only human-approved findings are included. Missing information means insufficient evidence, not absence of competitor activity.':'只包含人工批准的发现。缺失信息表示证据不足，不代表竞争对手没有相关活动。',
 'Source collection only. AI extraction has not run; collected pages are not approved findings and their market/quarter relevance needs human verification.':'仅收集了来源，尚未运行 AI 抽取；已收集页面不是获批发现，其市场与季度相关性仍需人工核验。',
 'Execution time limit reached. Remaining pages were not retrieved.':'已达到执行时间上限，剩余页面未抓取。',
 'No source URLs were found. Supply public HTTPS pages or check automatic search configuration.':'没有找到来源 URL。请提供公开 HTTPS 页面，或检查自动搜索配置。',
 'DeepSeek search response did not contain a results array.':'DeepSeek 搜索响应中没有结果数组。',
 'DeepSeek search failed.':'DeepSeek 搜索失败。',
 'DeepSeek response exceeds 2 MB limit.':'DeepSeek 响应超过 2 MB 限制。',
 'DeepSeek returned an empty response.':'DeepSeek 返回了空响应。',
 'DeepSeek returned invalid JSON.':'DeepSeek 返回了无效 JSON。',
 'DeepSeek Fetch returned insufficient readable source text.':'DeepSeek 抓取返回的可读正文不足。',
 'DeepSeek fetch returned insufficient readable source text.':'DeepSeek 抓取返回的可读正文不足。',
 'AI extraction is not configured. Add DEEPSEEK_API_KEY or complete AI settings.':'AI 抽取未配置，请添加 DEEPSEEK_API_KEY 或完成 AI 设置。',
 'AI endpoint must use HTTPS without URL credentials.':'AI 端点必须使用不带凭据的 HTTPS 地址。',
 'AI returned an empty response.':'AI 返回了空响应。',
 'AI response exceeds size limit.':'AI 响应超过大小限制。',
 'AI returned incomplete or invalid JSON. No findings were saved.':'AI 返回的 JSON 不完整或无效，没有保存任何发现。',
 'AI extraction is awaiting API configuration. Choose Collect public sources to save evidence without AI.':'AI 抽取正在等待 API 配置。可以选择"收集公开来源"先保存证据。',
 'Only standard public HTTPS URLs are eligible.':'仅支持标准的公开 HTTPS URL。',
 'Source must use a public internet hostname.':'来源必须使用公网主机名。',
 'Source domain is restricted by the administrator.':'该来源域名已被管理员限制。',
 'No readable page content was available.':'没有可读的页面内容。',
 'Provider rate limit reached; retry later.':'触发服务商限流，请稍后重试。',
 'DeepSeek account balance is insufficient.':'DeepSeek 账户余额不足。',
 'The provider rejected this public page.':'服务商拒绝了此公开页面。',
 'Check the backend DEEPSEEK_API_KEY.':'请检查后端的 DEEPSEEK_API_KEY。',
 'Retry later or check provider availability.':'请稍后重试或检查服务商可用性。',
 'Check the server API key.':'请检查服务端 API key。',
 'Check provider balance.':'请检查服务商余额。',
 'Rate limit reached. Try later.':'触发限流，请稍后重试。',
 'Check provider availability.':'请检查服务商可用性。',
 'Search unavailable':'搜索不可用',
 'Invalid URL':'无效 URL',
 'Source processing failed':'来源处理失败',
 'Research produced no result':'研究没有产生结果',
 'Saved source unavailable':'已保存来源不可用',
};

function reason(value:string){
 return exact[value] ?? value;
}

function toolName(tool:string){
 return tool==='search'?'搜索':'抓取';
}

export function translateNotice(text:string,lang:Lang):string{
 if(lang!=='zh'||!text)return text;
 if(exact[text])return exact[text];
 let match:RegExpExecArray|null;
 if((match=/^Source limit reached: processing (\d+) of (\d+) URLs; coverage is incomplete\.$/.exec(text)))
  return `已达到来源上限：本次处理 ${match[1]}/${match[2]} 个 URL，覆盖不完整。`;
 if((match=/^Publication date unknown: (.+)\. Quarter relevance has not been verified\.$/.exec(text)))
  return `发布日期未知：${match[1]}。季度相关性尚未核验。`;
 if((match=/^No supported in-scope findings: (.+)$/.exec(text)))
  return `没有符合范围的发现：${match[1]}`;
 if((match=/^Excluded source URL: (.+)$/.exec(text)))
  return `已排除来源 URL：${reason(match[1])}`;
 if((match=/^Automatic discovery failed: (.+)\. Provided and default URLs will still be processed\.$/.exec(text)))
  return `自动发现失败：${reason(match[1])}。已提供和默认的 URL 仍会继续处理。`;
 if((match=/^(\d+) search result\(s\) were excluded by the public HTTPS source policy\.$/.exec(text)))
  return `${match[1]} 条搜索结果因公开 HTTPS 来源策略被排除。`;
 if((match=/^DeepSeek (search|fetch) failed \(HTTP (\d+)\)\. (.+)$/.exec(text)))
  return `DeepSeek ${toolName(match[1])}失败（HTTP ${match[2]}）。${reason(match[3])}`;
 if((match=/^DeepSeek (search|fetch) could not connect or timed out\.$/.exec(text)))
  return `DeepSeek ${toolName(match[1])}无法连接或超时。`;
 if((match=/^AI extraction failed \(HTTP (\d+)\)\. (.+)$/.exec(text)))
  return `AI 抽取失败（HTTP ${match[1]}）。${reason(match[2])}`;
 if((match=/^(https?:\/\/\S+?): (.+)$/.exec(text)))
  return `${match[1]}：${translateNotice(match[2],lang)}`;
 return text;
}
