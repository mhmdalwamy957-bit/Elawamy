import {auth,db,doc,getDoc,setDoc,serverTimestamp} from './firebase.js';
const box=document.getElementById('catalogBox'),msg=document.getElementById('catalogMessage');
const fallback=['تصميم','برمجة','كتابة وترجمة','تسويق','فيديو وصوت','أعمال','تعليم وتدريب'];
async function load(){const s=await getDoc(doc(db,'platformSettings','catalog'));const cats=s.exists()&&Array.isArray(s.data().categories)?s.data().categories:fallback;box.value=cats.join('\n');}
document.getElementById('saveCatalog').onclick=async()=>{if(!auth.currentUser)return;const categories=box.value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,50);if(!categories.length){msg.textContent='أضف تصنيفًا واحدًا على الأقل.';return;}try{await setDoc(doc(db,'platformSettings','catalog'),{categories,updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid},{merge:true});msg.textContent='✅ تم حفظ التصنيفات';}catch(e){msg.textContent='❌ '+e.message;}};load();
