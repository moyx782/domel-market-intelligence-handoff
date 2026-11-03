import {useI18n} from './i18n';

export default function LanguageSwitch(){
 const {lang,setLang}=useI18n();
 return <div className="lang-switch" role="group" aria-label={lang==='zh'?'语言':'Language'}>
  <button type="button" className={lang==='zh'?'active':''} aria-pressed={lang==='zh'} lang="zh-CN" onClick={()=>setLang('zh')}>中文</button>
  <button type="button" className={lang==='en'?'active':''} aria-pressed={lang==='en'} lang="en" onClick={()=>setLang('en')}>EN</button>
 </div>;
}
