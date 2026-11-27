import { openOrderCheckout } from './order-checkout.js';
import {
  db,
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  auth
} from './firebase.js';
import { loadFavoriteIds, isFavorite, toggleFavorite } from './favorites.js';

const page = document.getElementById('service') || document.getElementById('servicePage');
const params = new URLSearchParams(location.search);
const serviceId = params.get('id');

const esc = (value = '') => {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
};

const money = value =>
  Number(value || 0).toLocaleString('ar-EG');

const deliveryText = value => {
  const days = Number(value || 3);
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days >= 3 && days <= 10) return `${days} أيام`;
  return `${days} يومًا`;
};

const ratingValue = value => {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return 0;
  return Math.max(0, Math.min(5, rating));
};

const stars = value => {
  const rating = Math.round(ratingValue(value));
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
};

const timeValue = value => {
  if (!value) return 0;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value?.seconds) return Number(value.seconds) * 1000;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

const safeImageUrl = value => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, location.origin);

    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && location.hostname === 'localhost')
    ) {
      return url.href;
    }

    if (url.protocol === 'data:') {
      return url.href.startsWith('data:image/')
        ? url.href
        : '';
    }

    return '';
  } catch {
    return '';
  }
};

const showMessage = message => {
  const element =
    document.getElementById('reviewMessage') ||
    document.getElementById('orderMessage') ||
    document.getElementById('message');

  if (element) {
    element.textContent = message;
  }
};

      async function loadReviews(user) {
  const section = document.getElementById('reviews');
  const list = document.getElementById('reviewsList');
  const form = document.getElementById('reviewForm');

  if (!section || !list) return;

  section.hidden = false;

  let reviews = [];

  try {
    const snapshot = await getDocs(
      query(
        collection(db, 'reviews'),
        where('serviceId', '==', serviceId),
        orderBy('createdAt', 'desc'),
        limit(20)
      )
    );

    reviews = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data()
    }));
  } catch (error) {
    console.error('REVIEWS ERROR:', error);

    list.innerHTML = `
      <div class="empty">
        تعذر تحميل التقييمات حاليًا.
      </div>
    `;

    return [];
  }


  if (!reviews.length) {
    list.innerHTML = `
      <div class="empty">
        ⭐ لا توجد تقييمات حتى الآن.
        <br>
        كن أول من يقيّم هذه الخدمة.
      </div>
    `;
  } else {
    list.innerHTML = reviews.map((review) => `
      <article class="review">

        <div class="review-head">

          <div class="review-user">
            <div class="avatar">
              ${esc(
                'م'
                  .charAt(0)
                  .toUpperCase()
              )}
            </div>

            <div>
              <b>
                مشتري
              </b>

              <div class="rating">
                ${stars(review.rating)}
              </div>
            </div>

          </div>

        </div>

        <p>
          ${esc(review.text || 'تجربة جيدة بدون تعليق.')}
        </p>

      </article>
    `).join('');
  }

  if (!user || !form) {
    return reviews;
  }

  // Allow one review per completed order. Reading the exact review document
  // avoids requiring a separate serviceId + userId composite index.
  let completedOrder = null;

  try {
    const ordersSnapshot = await getDocs(
      query(
        collection(db, 'orders'),
        where('userId', '==', user.uid),
        where('serviceId', '==', serviceId),
        where('status', '==', 'completed'),
        limit(50)
      )
    );

    for (const orderDoc of ordersSnapshot.docs) {
      const reviewSnapshot = await getDoc(
        doc(db, 'reviews', `${orderDoc.id}__${user.uid}`)
      );
      if (!reviewSnapshot.exists()) {
        completedOrder = {
          id: orderDoc.id,
          ...orderDoc.data()
        };
        break;
      }
    }
  } catch (error) {
    console.error('ORDER REVIEW ELIGIBILITY ERROR:', error);
  }
  if (completedOrder) {
    form.hidden = false;

    const reviewButton =
      document.getElementById('reviewBtn');

    reviewButton?.addEventListener(
      'click',
      () => submitReview(
        user,
        completedOrder.id,
        completedOrder.sellerId
      ),
      { once: true }
    );
  }

  return reviews;
}

async function submitReview(user, orderId, sellerId) {
  const ratingInput =
    document.getElementById('reviewRating');

  const textInput =
    document.getElementById('reviewText');

  const button =
    document.getElementById('reviewBtn');

  const rating = Number(
    ratingInput?.value
  );

  const text =
    textInput?.value.trim() || '';

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    showMessage(
      'التقييم يجب أن يكون من 1 إلى 5 نجوم.',
      'error'
    );

    return;
  }

  if (text.length > 2000) {
    showMessage(
      'اكتب تقييمًا من 1 إلى 2000 حرف.',
      'error'
    );

    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'جاري إرسال التقييم...';
  }

  showMessage('جاري إرسال التقييم...');

  try {
    const reviewId = `${orderId}__${user.uid}`;

    await setDoc(
      doc(db, 'reviews', reviewId),
      {
        serviceId: serviceId,
        orderId,
        userId: user.uid,
        rating,
        text,
        createdAt: serverTimestamp()
      }
    );

    // تحديث متوسط التقييم وعدد التقييمات من خلال الـ backend الموثوق
    try {
      const idToken = await user.getIdToken();

      const response = await fetch(
        'https://elawamy-file-server.vercel.app/api/reviews/recalculate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`
          },
          body: JSON.stringify({
            serviceId,
            orderId
          })
        }
      );

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          result.error || 'تعذر تحديث متوسط التقييم'
        );
      }

      console.log('RATING RECALCULATED:', result);
    } catch (ratingError) {
      // التقييم تم حفظه بالفعل، لذلك لا نعتبر فشل التحديث سببًا لفشل التقييم
      console.error(
        'RATING RECALCULATE ERROR:',
        ratingError
      );
    }

    showMessage(
      'تم إرسال تقييمك بنجاح ⭐',
      'success'
    );

    if (document.getElementById('reviewForm')) {
      document.getElementById('reviewForm').hidden = true;
    }

    await loadReviews(user);

  } catch (error) {
    console.error('SUBMIT REVIEW ERROR:', error);

    if (button) {
      button.disabled = false;
      button.textContent = 'إرسال التقييم';
    }

    showMessage(
      'تعذر إرسال التقييم: ' +
      (error.code || error.message),
      'error'
    );
  }
}



if (!serviceId) {
  page.innerHTML = `
    <div class="empty">
      <strong>لم يتم تحديد الخدمة</strong>
      <p>ارجع إلى صفحة الخدمات واختر خدمة لعرض تفاصيلها.</p>
      <a class="btn" href="/">العودة للخدمات</a>
    </div>
  `;
} else {
  try {
    const serviceSnap = await getDoc(
      doc(db, 'services', serviceId)
    );

    if (!serviceSnap.exists()) {
      page.innerHTML = `
        <div class="empty">
          <strong>الخدمة غير موجودة</strong>
          <p>ربما تم حذف الخدمة أو أن الرابط غير صحيح.</p>
          <a class="btn" href="/">العودة للخدمات</a>
        </div>
      `;
    } else {
      const service = {
        id: serviceSnap.id,
        ...serviceSnap.data()
      };

      let seller = null;

      if (service.ownerId) {
        const sellerSnap = await getDoc(
          doc(db, 'sellerProfiles', service.ownerId)
        );

        if (sellerSnap.exists()) {
          seller = sellerSnap.data();
        }
      }

      const imageUrl = safeImageUrl(service.imageUrl);

      const image = imageUrl
        ? `
          <img
            class="service-detail-image"
            src="${esc(imageUrl)}"
            alt="${esc(service.name || 'الخدمة')}"
          >
        `
        : `
          <div class="service-detail-image placeholder">
            <span>ElaWamy</span>
          </div>
        `;

      const sellerName =
        seller?.name ||
        service.ownerName ||
        'بائع ElaWamy';

      const sellerInitial =
        String(sellerName.charAt(0) || 'ب').toUpperCase();

      const rating = ratingValue(service.rating);
      const ratingCount = Number(service.ratingCount || 0);

      page.innerHTML = `
        <div class="service-detail-layout">

          <section class="service-detail-main">

            <div class="service-detail-media">
              ${image}
            </div>

            <div class="service-detail-content">

              <div class="service-top">
                <span class="badge">
                  ${esc(service.category || 'عام')}
                </span>

                <span class="delivery">
                  ⏱ التسليم خلال ${deliveryText(service.deliveryDays)}
                </span>
              </div>

              <h1>
                ${esc(service.name || 'خدمة بدون اسم')}
              </h1>

              <div class="service-actions">
                <button
                  id="favoriteService"
                  class="favorite-detail-btn"
                  type="button"
                  aria-pressed="false"
                >
                  ♡ إضافة للمفضلة
                </button>
              </div>

              <div class="service-rating" id="serviceRating">
                <span class="stars">${stars(rating)}</span>
                <strong class="service-rating-value">${rating.toFixed(1)}</strong>
                <span class="rating-count">
                  (<span class="service-rating-count">${ratingCount}</span> تقييم)
                </span>
              </div>

              <div class="service-description-detail">
                <h2>وصف الخدمة</h2>
                <p>
                  ${esc(
                    service.description ||
                    'لم يضف مقدم الخدمة وصفًا للخدمة بعد.'
                  )}
                </p>
              </div>

              <div class="service-features">
                <div>
                  <strong>✓</strong>
                  <span>خدمة رقمية</span>
                </div>

                <div>
                  <strong>✓</strong>
                  <span>مدة تسليم واضحة</span>
                </div>

                <div>
                  <strong>✓</strong>
                  <span>سعر محدد</span>
                </div>
              </div>

            </div>
          </section>

          <aside class="service-detail-sidebar">

            <div class="order-card">

              <div class="order-price">
                <small>سعر الخدمة</small>
                <strong>
                  ${money(service.price)}
                  <span>ج.م</span>
                </strong>
              </div>

              <div class="order-info">
                <div>
                  <span>مدة التنفيذ</span>
                  <strong>${deliveryText(service.deliveryDays)}</strong>
                </div>

                <div>
                  <span>التصنيف</span>
                  <strong>${esc(service.category || 'عام')}</strong>
                </div>
              </div>

              <button
                id="orderService"
                class="btn order-btn"
                type="button"
              >
                اطلب هذه الخدمة
              </button>

              <p id="orderMessage" class="order-message"></p>

            </div>

            <div class="seller-detail-card">

              <div class="seller-detail-head">

                <span class="seller-avatar">
                  ${esc(sellerInitial)}
                </span>

                <div>
                  <small>مقدم الخدمة</small>

                  ${
                    service.ownerId
                      ? `
                        <a
                          class="seller-name-link"
                          href="/seller?uid=${encodeURIComponent(service.ownerId)}"
                        >
                          ${esc(sellerName)}
                        </a>
                      `
                      : `
                        <strong>${esc(sellerName)}</strong>
                      `
                  }
                </div>

              </div>

              ${
                seller?.bio
                  ? `
                    <p class="seller-detail-bio">
                      ${esc(seller.bio)}
                    </p>
                  `
                  : ''
              }

              ${
                service.ownerId
                  ? `
                    <a
                      class="market-link"
                      href="/seller?uid=${encodeURIComponent(service.ownerId)}"
                    >
                      عرض ملف البائع
                    </a>
                  `
                  : ''
              }

              ${
                service.ownerId
                  ? `
                    <a
                      id="contactSellerPrimary"
                      class="btn secondary"
                      hidden
                      href="#"
                    >
                      💬 تواصل مع البائع قبل الشراء
                    </a>
                  `
                  : ''
              }

            </div>

          </aside>

        </div>
      `;

      const contactSeller = document.getElementById('contactSellerPrimary');

      if (contactSeller && service.ownerId) {
        const currentUser = auth.currentUser;
        if (!currentUser || currentUser.uid !== service.ownerId) {
          const params = new URLSearchParams({
            seller: service.ownerId,
            service: service.id
          });
          contactSeller.href = `/messages?${params.toString()}`;
          contactSeller.hidden = false;
        } else {
          contactSeller.hidden = true;
        }
      }

      const favoriteButton = document.getElementById('favoriteService');

      if (favoriteButton) {
        const updateFavoriteButton = (added) => {
          favoriteButton.textContent = added
            ? '♥ إزالة من المفضلة'
            : '♡ إضافة للمفضلة';
          favoriteButton.classList.toggle('is-favorite', added);
          favoriteButton.setAttribute('aria-pressed', String(added));
        };

        let serviceFavoriteIds = new Set();

        if (auth.currentUser) {
          try {
            serviceFavoriteIds = await loadFavoriteIds(auth.currentUser);
            updateFavoriteButton(isFavorite(service.id, serviceFavoriteIds));
          } catch (error) {
            console.error('LOAD SERVICE FAVORITE ERROR:', error);
          }
        }

        favoriteButton.addEventListener('click', async () => {
          if (!auth.currentUser) {
            location.href = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
            return;
          }

          if (favoriteButton.disabled) return;
          favoriteButton.disabled = true;

          try {
            const added = await toggleFavorite(
              service.id,
              serviceFavoriteIds,
              auth.currentUser
            );
            updateFavoriteButton(added);
          } catch (error) {
            console.error('SERVICE FAVORITE ERROR:', error);
          } finally {
            favoriteButton.disabled = false;
          }
        });
      }

      await loadReviews(auth.currentUser);

      try {
        const structured = document.getElementById('serviceStructuredData');
        if (structured) {
          structured.textContent = JSON.stringify({
            '@context':'https://schema.org',
            '@type':'Service',
            name: service.name || 'خدمة ElaWamy',
            description: service.description || '',
            provider: { '@type':'Person', name: seller?.name || service.ownerName || 'مقدم الخدمة' },
            offers: { '@type':'Offer', price: Number(service.price || 0), priceCurrency:'EGP', availability:'https://schema.org/InStock' }
          });
        }
      } catch (structuredError) { console.warn('STRUCTURED DATA ERROR:', structuredError); }

      const serviceRating = ratingValue(service.rating);
      const serviceRatingCount = Math.max(
        0,
        Number(service.ratingCount || 0)
      );

      const ratingStars =
        document.querySelector('#serviceRating .stars');

      const ratingValueElement =
        document.querySelector('#serviceRating .service-rating-value');

      const ratingCountElement =
        document.querySelector('#serviceRating .service-rating-count');

      if (ratingStars) {
        ratingStars.textContent = stars(serviceRating);
      }

      if (ratingValueElement) {
        ratingValueElement.textContent = serviceRating.toFixed(1);
      }

      if (ratingCountElement) {
        ratingCountElement.textContent =
          String(serviceRatingCount);
      }

document
        .getElementById('orderService')
        ?.addEventListener('click', async () => {
          const message =
            document.getElementById('orderMessage');

          const user = auth.currentUser;

          if (!user) {
            location.href =
              `/login?redirect=${encodeURIComponent(
                location.pathname + location.search
              )}`;
            return;
          }

          if (
            service.ownerId &&
            service.ownerId === user.uid
          ) {
            message.textContent =
              'لا يمكنك طلب خدمتك الخاصة.';
            return;
          }

          try {
            openOrderCheckout(service);
          } catch (error) {
            console.error(
              'OPEN ORDER CHECKOUT ERROR:',
              error
            );

            message.textContent =
              'تعذر فتح نموذج الطلب.';
          }
        });
    }

  } catch (error) {
    console.error('SERVICE PAGE ERROR:', error);

    page.innerHTML = `
      <div class="empty">
        <strong>حدث خطأ أثناء تحميل الخدمة</strong>
        <p>حاول تحديث الصفحة مرة أخرى.</p>
        <a class="btn" href="/">العودة للخدمات</a>
      </div>
    `;
  }
}
