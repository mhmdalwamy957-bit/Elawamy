import {db,doc,getDoc} from './firebase.js';
const fallback=['تصميم','برمجة','كتابة وترجمة','تسويق','فيديو وصوت','أعمال','تعليم وتدريب'];
export async function loadCategories(selectId='category'){
  const select=document.getElementById(selectId); if(!select)return fallback;
  const current=select.value;
  let categories=fallback;
  try{const snap=await getDoc(doc(db,'platformSettings','catalog'));const v=snap.exists()?snap.data().categories:null;if(Array.isArray(v)&&v.length)categories=v.map(x=>String(x).trim()).filter(x=>x&&x.length<=60).slice(0,50);}catch(e){console.warn('CATEGORY SOURCE:',e);}
  select.innerHTML='<option value="">اختر التصنيف</option>'+categories.map(c=>`<option value="${c.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${c}</option>`).join('');
  if(categories.includes(current))select.value=current;
  return categories;
}
