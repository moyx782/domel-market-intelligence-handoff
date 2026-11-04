// Compatibility labels preserve evidence review/report contracts without inventing scope.
export function agentBriefProject(direction, question, now = new Date()) {
 const topic=String(direction??'').trim(), prompt=String(question??'').trim();
 if(!topic||topic.length>120||!prompt||prompt.length>1500)throw Error('Invalid research brief');
 return {title:topic,question:`Research direction: ${topic}\n\nResearch questions and requirements:\n${prompt}`,segment:topic,market:'Defined in research brief',quarter:`${now.getFullYear()}-Q${Math.floor(now.getMonth()/3)+1}`,competitors:['Research subject'],focus:['Research findings'],source_urls:[]};
}
