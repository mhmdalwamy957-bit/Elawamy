const CATEGORY_META = {
  'تصميم': 'تصميم الشعارات، الهوية البصرية، واجهات المواقع والتصميمات الرقمية.',
  'برمجة': 'برمجة المواقع والتطبيقات وحلول الويب والأنظمة الرقمية.',
  'كتابة وترجمة': 'كتابة المحتوى والترجمة والتدقيق وصناعة النصوص الاحترافية.',
  'تسويق': 'التسويق الرقمي، إدارة المحتوى، الحملات والإعلانات.',
  'فيديو وصوت': 'المونتاج، التعليق الصوتي، الفيديوهات والإنتاج الرقمي.',
  'أعمال': 'المساعدة الافتراضية، البيانات، الأعمال والخدمات المهنية.',
  'تعليم وتدريب': 'الدروس، التدريب، الاستشارات التعليمية والمهارات العملية.'
};

const params = new URLSearchParams(location.search);
const category = String(params.get('category') || params.get('name') || '').trim();

const title = document.getElementById('categoryTitle');
const description = document.getElementById('categoryDescription');

if (category) {
  title.textContent = `خدمات ${category}`;
  description.textContent = CATEGORY_META[category] || `تصفح خدمات ${category} واختر ما يناسب احتياجك.`;
  document.title = `خدمات ${category} | ElaWamy`;
}
