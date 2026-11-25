import {
  auth,
  onAuthStateChanged,
  signOut
} from './firebase.js';

import { watchServices, loadMoreServices } from './firestore-services.js';
import { loadFavoriteIds, isFavorite, toggleFavorite } from './favorites.js';

const grid = document.getElementById('servicesGrid');
const search = document.getElementById('search');
const category = document.getElementById('category');
const sort = document.getElementById('sort');
const resultCount = document.getElementById('resultCount');
const mobileMenu = document.getElementById('mobileMenu');
const mainNav = document.getElementById('mainNav');

let services = [];
let currentUser = null;
let favoriteIds = new Set();

const CATEGORIES = [
  'تصميم',
  'برمجة',
  'كتابة وترجمة',
  'تسويق',
  'فيديو وصوت',
  'أعمال',
  'تعليم وتدريب'
];

const FILTER_LIMITS = {
  minPrice: 0,
  maxPrice: 100000,
  maxDelivery: 90
};

const filterState = {
  query: '',
  category: '',
  minPrice: '',
  maxPrice: '',
  maxDelivery: '',
  minRating: '',
  sort: 'latest'
};

function readFiltersFromUrl() {
  const params = new URLSearchParams(location.search);

  filterState.query = String(params.get('q') || '').trim();
  filterState.category = String(
    params.get('category') || params.get('name') || ''
  ).trim();
  filterState.minPrice = normalizeNumberParam(
    params.get('minPrice'),
    FILTER_LIMITS.minPrice,
    FILTER_LIMITS.maxPrice
  );
  filterState.maxPrice = normalizeNumberParam(
    params.get('maxPrice'),
    FILTER_LIMITS.minPrice,
    FILTER_LIMITS.maxPrice
  );
  filterState.maxDelivery = normalizeNumberParam(
    params.get('delivery'),
    1,
    FILTER_LIMITS.maxDelivery
  );
  filterState.minRating = normalizeNumberParam(
    params.get('rating'),
    1,
    5
  );
  filterState.sort = String(params.get('sort') || 'latest');

  if (!['latest', 'rating', 'price-low', 'price-high', 'delivery-fast'].includes(filterState.sort)) {
    filterState.sort = 'latest';
  }

  if (
    filterState.minPrice &&
    filterState.maxPrice &&
    Number(filterState.minPrice) > Number(filterState.maxPrice)
  ) {
    [filterState.minPrice, filterState.maxPrice] = [
      filterState.maxPrice,
      filterState.minPrice
    ];
  }
}

function normalizeNumberParam(value, min, max) {
  if (value == null || value === '') return '';

  const number = Number(value);

  if (!Number.isFinite(number)) return '';
  if (number < min || number > max) return '';

  return String(number);
}

function syncFilterControls() {
  if (search) search.value = filterState.query;
  if (category) category.value = filterState.category;

  const minPrice = document.getElementById('minPrice');
  const maxPrice = document.getElementById('maxPrice');
  const maxDelivery = document.getElementById('maxDelivery');
  const minRating = document.getElementById('minRating');

  if (minPrice) minPrice.value = filterState.minPrice;
  if (maxPrice) maxPrice.value = filterState.maxPrice;
  if (maxDelivery) maxDelivery.value = filterState.maxDelivery;
  if (minRating) minRating.value = filterState.minRating;
  if (sort) sort.value = filterState.sort;
}

function syncUrlFromFilters() {
  const params = new URLSearchParams();

  if (filterState.query) params.set('q', filterState.query);
  if (filterState.category) params.set('category', filterState.category);
  if (filterState.minPrice) params.set('minPrice', filterState.minPrice);
  if (filterState.maxPrice) params.set('maxPrice', filterState.maxPrice);
  if (filterState.maxDelivery) params.set('delivery', filterState.maxDelivery);
  if (filterState.minRating) params.set('rating', filterState.minRating);
  if (filterState.sort !== 'latest') params.set('sort', filterState.sort);

  const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash || ''}`;
  history.replaceState(null, '', next);
}

function setFilter(key, value) {
  filterState[key] = String(value || '').trim();

  if (key === 'minPrice') {
    filterState.minPrice = normalizeNumberParam(
      filterState.minPrice,
      FILTER_LIMITS.minPrice,
      FILTER_LIMITS.maxPrice
    );
  }

  if (key === 'maxPrice') {
    filterState.maxPrice = normalizeNumberParam(
      filterState.maxPrice,
      FILTER_LIMITS.minPrice,
      FILTER_LIMITS.maxPrice
    );
  }

  if (key === 'maxDelivery') {
    filterState.maxDelivery = normalizeNumberParam(
      filterState.maxDelivery,
      1,
      FILTER_LIMITS.maxDelivery
    );
  }

  if (key === 'minRating') {
    filterState.minRating = normalizeNumberParam(
      filterState.minRating,
      1,
      5
    );
  }

  if (
    filterState.minPrice &&
    filterState.maxPrice &&
    Number(filterState.minPrice) > Number(filterState.maxPrice)
  ) {
    if (key === 'minPrice') {
      filterState.maxPrice = filterState.minPrice;
    } else {
      filterState.minPrice = filterState.maxPrice;
    }
  }

  syncUrlFromFilters();
  syncFilterControls();
  render();
}

function clearFilters() {
  filterState.query = '';
  filterState.category = '';
  filterState.minPrice = '';
  filterState.maxPrice = '';
  filterState.maxDelivery = '';
  filterState.minRating = '';
  filterState.sort = 'latest';

  syncUrlFromFilters();
  syncFilterControls();
  render();
}

function esc(value = '') {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''), location.origin);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    return url.href;
  } catch {
    return '';
  }
}

function getRating(value) {
  const rating = Number(value);

  if (!Number.isFinite(rating)) {
    return 0;
  }

  return Math.max(0, Math.min(5, rating));
}

function stars(value) {
  const rating = Math.round(getRating(value));

  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function formatPrice(value) {
  const price = Number(value || 0);

  return price.toLocaleString('ar-EG');
}

function formatDelivery(value) {
  const days = Number(value || 3);

  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days >= 3 && days <= 10) return `${days} أيام`;

  return `${days} يومًا`;
}

function sellerName(service) {
  return (
    service.ownerName ||
    service.sellerName ||
    'بائع ElaWamy'
  );
}

function sellerInitial(service) {
  return String(
    sellerName(service).charAt(0) || 'ب'
  ).toUpperCase();
}

function sellerLink(service) {
  if (!service.ownerId) {
    return `<strong>${esc(sellerName(service))}</strong>`;
  }

  return `
    <a
      class="seller-name-link"
      href="/seller?uid=${encodeURIComponent(service.ownerId)}"
    >
      ${esc(sellerName(service))}
    </a>
  `;
}

function card(service) {
  const imageUrl = safeImageUrl(service.imageUrl);

  const image = imageUrl
    ? `
      <img
        class="service-image"
        src="${esc(imageUrl)}"
        alt="${esc(service.name || 'صورة الخدمة')}"
        loading="lazy"
      >
    `
    : `
      <div class="service-image placeholder">
        <span>ElaWamy</span>
      </div>
    `;

  const rating = getRating(service.rating);
  const ratingCount = Number(service.ratingCount || 0);

  return `
    <article class="card service-card">

      <a
        class="service-media"
        href="/service?id=${encodeURIComponent(service.id)}"
        aria-label="عرض ${esc(service.name || 'الخدمة')}"
      >
        ${image}
      </a>

      <div class="card-body">

        <button
          class="favorite-btn ${isFavorite(service.id, favoriteIds) ? 'is-favorite' : ''}"
          type="button"
          data-favorite-service="${esc(service.id)}"
          aria-label="${isFavorite(service.id, favoriteIds) ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}"
          aria-pressed="${isFavorite(service.id, favoriteIds) ? 'true' : 'false'}"
          title="${isFavorite(service.id, favoriteIds) ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}"
        >${isFavorite(service.id, favoriteIds) ? '♥' : '♡'}</button>

        <div class="service-top">

          <span class="badge">
            ${esc(service.category || 'عام')}
          </span>

          <span class="delivery">
            ⏱ ${formatDelivery(service.deliveryDays)}
          </span>

        </div>

        <h3 class="service-title">
          <a
            href="/service?id=${encodeURIComponent(service.id)}"
          >
            ${esc(service.name || 'خدمة بدون اسم')}
          </a>
        </h3>

        <p class="service-description">
          ${esc(service.description || 'لا يوجد وصف للخدمة.')}
        </p>

        <div
          class="service-rating"
          aria-label="التقييم ${rating} من 5"
        >
          <span class="stars">${stars(rating)}</span>
          <strong>${rating.toFixed(1)}</strong>

          <span class="rating-count">
            (${ratingCount} تقييم)
          </span>
        </div>

        <div class="seller">

          <span
            class="seller-avatar"
            aria-hidden="true"
          >
            ${esc(sellerInitial(service))}
          </span>

          <div>
            <small>مقدم الخدمة</small>
            ${sellerLink(service)}
          </div>

        </div>

        <div class="card-foot">

          <div class="price-box">
            <small>يبدأ من</small>

            <strong>
              ${formatPrice(service.price)}
              <span>ج.م</span>
            </strong>
          </div>

          <a
            class="btn small"
            href="/service?id=${encodeURIComponent(service.id)}"
          >
            عرض الخدمة
          </a>

        </div>

      </div>

    </article>
  `;
}

function setupFavoriteButtons() {
  if (!grid) return;

  grid.querySelectorAll('[data-favorite-service]').forEach((button) => {
    button.addEventListener('click', async () => {
      const serviceId = button.dataset.favoriteService;
      if (!serviceId) return;

      if (!currentUser) {
        location.href = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }

      if (button.disabled) return;
      button.disabled = true;

      try {
        const added = await toggleFavorite(serviceId, favoriteIds, currentUser);
        button.classList.toggle('is-favorite', added);
        button.textContent = added ? '♥' : '♡';
        button.setAttribute('aria-pressed', String(added));
        button.setAttribute('aria-label', added ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة');
        button.title = added ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة';
      } catch (error) {
        console.error('FAVORITE ERROR:', error);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function updateResultCount(count) {
  if (!resultCount) return;

  const loaded = services.length;
  const suffix = servicesPageState.hasMore
    ? ` من ${loaded.toLocaleString('ar-EG')} محملة`
    : '';

  resultCount.textContent =
    `${count.toLocaleString('ar-EG')} خدمة${suffix}`;
}

function activeFilterCount() {
  return [
    filterState.query,
    filterState.category,
    filterState.minPrice,
    filterState.maxPrice,
    filterState.maxDelivery,
    filterState.minRating
  ].filter(Boolean).length;
}

function updateActiveFilters() {
  const element = document.getElementById('activeFilters');
  if (!element) return;

  const labels = [];

  if (filterState.category) {
    labels.push(`التصنيف: ${filterState.category}`);
  }

  if (filterState.minPrice) {
    labels.push(`من ${formatPrice(filterState.minPrice)} ج.م`);
  }

  if (filterState.maxPrice) {
    labels.push(`حتى ${formatPrice(filterState.maxPrice)} ج.م`);
  }

  if (filterState.maxDelivery) {
    labels.push(`حتى ${filterState.maxDelivery} يوم`);
  }

  if (filterState.minRating) {
    labels.push(`تقييم ${filterState.minRating}★ فأعلى`);
  }

  element.innerHTML = `
    <div class="active-filter-summary">
      <span>${activeFilterCount() ? `الفلاتر النشطة: ${activeFilterCount()}` : 'بدون فلاتر إضافية'}</span>
      ${labels.map((label) => `<span class="filter-pill">${esc(label)}</span>`).join('')}
      ${activeFilterCount() ? '<button type="button" id="clearFiltersTop" class="clear-filters-btn">مسح الكل</button>' : ''}
    </div>
  `;

  element
    .querySelector('#clearFiltersTop')
    ?.addEventListener('click', clearFilters);
}

function render() {
  if (!grid) return;

  filterState.query = String(search?.value || filterState.query || '').trim();
  filterState.category = String(category?.value || filterState.category || '').trim();
  filterState.sort = String(sort?.value || filterState.sort || 'latest');

  const minPrice = Number(filterState.minPrice);
  const maxPrice = Number(filterState.maxPrice);
  const maxDelivery = Number(filterState.maxDelivery);
  const minRating = Number(filterState.minRating);

  const q = filterState.query.toLowerCase();
  const selectedCategory = filterState.category;
  const selectedSort = filterState.sort;

  let filtered = services.filter((service) => {
    if (service.status !== 'approved') return false;

    const text = `
      ${service.name || ''}
      ${service.description || ''}
      ${service.category || ''}
      ${service.ownerName || ''}
      ${(Array.isArray(service.tags) ? service.tags.join(' ') : service.tags || '')}
    `.toLowerCase();

    const matchesSearch = !q || text.includes(q);
    const matchesCategory = !selectedCategory || service.category === selectedCategory;

    const price = Number(service.price || 0);
    const delivery = Number(service.deliveryDays || 0);
    const rating = getRating(service.rating);

    const matchesMinPrice = !filterState.minPrice || price >= minPrice;
    const matchesMaxPrice = !filterState.maxPrice || price <= maxPrice;
    const matchesDelivery = !filterState.maxDelivery || delivery <= maxDelivery;
    const matchesRating = !filterState.minRating || rating >= minRating;

    return (
      matchesSearch &&
      matchesCategory &&
      matchesMinPrice &&
      matchesMaxPrice &&
      matchesDelivery &&
      matchesRating
    );
  });

  filtered.sort((a, b) => {
    if (selectedSort === 'price-low') {
      return Number(a.price || 0) - Number(b.price || 0);
    }

    if (selectedSort === 'price-high') {
      return Number(b.price || 0) - Number(a.price || 0);
    }

    if (selectedSort === 'rating') {
      return getRating(b.rating) - getRating(a.rating);
    }

    if (selectedSort === 'delivery-fast') {
      return Number(a.deliveryDays || 0) - Number(b.deliveryDays || 0);
    }

    return getCreatedTime(b) - getCreatedTime(a);
  });

  updateResultCount(filtered.length);
  updateActiveFilters();

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty marketplace-empty">
        <div class="empty-icon">🔎</div>
        <strong>${
          servicesPageState.hasMore
            ? 'لم نجد تطابقًا ضمن الخدمات المحمّلة بعد'
            : 'لم نجد خدمة مطابقة'
        }</strong>
        <p>${
          servicesPageState.hasMore
            ? 'اضغط «تحميل المزيد» للبحث في خدمات إضافية، أو غيّر الفلاتر.'
            : 'جرّب كلمة بحث أخرى أو غيّر التصنيف والسعر والتقييم.'
        }</p>
        <button type="button" class="btn small" id="clearFilters">مسح الفلاتر</button>
      </div>
    `;

    document
      .getElementById('clearFilters')
      ?.addEventListener('click', clearFilters);

    return;
  }

  grid.innerHTML = filtered.map(card).join('');
  setupFavoriteButtons();
}

function getCreatedTime(service) {
  const value = service.createdAt;

  if (!value) {
    return 0;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (value?.seconds) {
    return Number(value.seconds) * 1000;
  }

  if (typeof value?.toDate === 'function') {
    return value.toDate().getTime();
  }

  const date = new Date(value);

  return Number.isFinite(date.getTime())
    ? date.getTime()
    : 0;
}

function updateCategories() {
  if (!category) return;

  const current = filterState.category || category.value;

  const existing = services
    .map((service) => service.category)
    .filter(Boolean);

  const categories = [
    ...new Set([
      ...CATEGORIES,
      ...existing
    ])
  ];

  category.innerHTML = `
    <option value="">كل التصنيفات</option>
    ${categories.map((item) => `
      <option value="${esc(item)}">${esc(item)}</option>
    `).join('')}
  `;

  if (categories.includes(current)) {
    category.value = current;
    filterState.category = current;
  } else if (current) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = current;
    category.appendChild(option);
    category.value = current;
  }
}

function setupCategoryChips() {
  document.querySelectorAll('[data-category-filter]').forEach((chip) => {
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      setFilter('category', chip.dataset.categoryFilter || '');
      document
        .getElementById('services')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function setupAdvancedFilters() {
  document
    .getElementById('clearAllFilters')
    ?.addEventListener('click', clearFilters);

  document.getElementById('minPrice')?.addEventListener('change', (event) => {
    setFilter('minPrice', event.target.value);
  });

  document.getElementById('maxPrice')?.addEventListener('change', (event) => {
    setFilter('maxPrice', event.target.value);
  });

  document.getElementById('maxDelivery')?.addEventListener('change', (event) => {
    setFilter('maxDelivery', event.target.value);
  });

  document.getElementById('minRating')?.addEventListener('change', (event) => {
    setFilter('minRating', event.target.value);
  });
}

function setupAuthUI() {

  const guestElements =
    document.querySelectorAll('[data-guest]');

  const authElements =
    document.querySelectorAll('[data-auth]');

  const userElements =
    document.querySelectorAll('[data-user]');

  const addServiceLinks =
    document.querySelectorAll('[data-add-service]');

  const sellerDashboardLinks =
    document.querySelectorAll('[data-seller-dashboard]');

  if (currentUser) {

    userElements.forEach((element) => {
      element.textContent =
        currentUser.email || 'مستخدم';
    });

    guestElements.forEach((element) => {
      element.hidden = true;
    });

    authElements.forEach((element) => {
      element.hidden = false;
    });

    addServiceLinks.forEach((element) => {
      element.setAttribute(
        'href',
        '/add-service'
      );
    });

    sellerDashboardLinks.forEach((element) => {
      element.hidden = false;
    });

  } else {

    guestElements.forEach((element) => {
      element.hidden = false;
    });

    authElements.forEach((element) => {
      element.hidden = true;
    });

    addServiceLinks.forEach((element) => {
      element.setAttribute(
        'href',
        '/login?redirect=%2Fadd-service'
      );
    });

    sellerDashboardLinks.forEach((element) => {
      element.hidden = true;
    });
  }
}

function setupLogout() {

  document
    .getElementById('logout')
    ?.addEventListener(
      'click',
      async () => {

        try {
          await signOut(auth);

          location.replace('/');

        } catch (error) {

          console.error(
            'LOGOUT ERROR:',
            error
          );
        }
      }
    );
}

function setupMobileMenu() {

  if (!mobileMenu || !mainNav) {
    return;
  }

  mobileMenu.addEventListener(
    'click',
    () => {

      const open =
        mainNav.classList.toggle(
          'mobile-open'
        );

      mobileMenu.setAttribute(
        'aria-expanded',
        String(open)
      );
    }
  );

  mainNav
    .querySelectorAll('a')
    .forEach((link) => {

      link.addEventListener(
        'click',
        () => {
          mainNav.classList.remove(
            'mobile-open'
          );

          mobileMenu.setAttribute(
            'aria-expanded',
            'false'
          );
        }
      );
    });
}

let servicesPageState = {
  hasMore: false,
  loadingMore: false
};

let loadMoreButton = null;

function setupLoadMoreButton() {
  if (!grid || loadMoreButton) {
    return;
  }

  const container = document.createElement('div');

  container.className = 'load-more-services-wrap';

  loadMoreButton = document.createElement('button');

  loadMoreButton.type = 'button';
  loadMoreButton.className = 'load-more-services';
  loadMoreButton.textContent = 'تحميل المزيد';
  loadMoreButton.hidden = true;

  loadMoreButton.addEventListener(
    'click',
    async () => {
      if (
        servicesPageState.loadingMore ||
        !servicesPageState.hasMore
      ) {
        return;
      }

      try {
        await loadMoreServices(
          (list, state = {}) => {
            services =
              Array.isArray(list)
                ? list
                : [];

            servicesPageState = {
              hasMore: Boolean(state.hasMore),
              loadingMore: Boolean(state.loadingMore)
            };

            updateCategories();
            render();
            updateLoadMoreButton();
          }
        );
      } catch (error) {
        console.error(
          'HOME LOAD MORE SERVICES ERROR:',
          error
        );

        servicesPageState.loadingMore = false;
        updateLoadMoreButton();
      }
    }
  );

  container.appendChild(loadMoreButton);

  grid.insertAdjacentElement(
    'afterend',
    container
  );
}

function updateLoadMoreButton() {
  if (!loadMoreButton) {
    return;
  }

  loadMoreButton.hidden =
    !servicesPageState.hasMore;

  loadMoreButton.disabled =
    servicesPageState.loadingMore;

  loadMoreButton.textContent =
    servicesPageState.loadingMore
      ? 'جارٍ تحميل المزيد...'
      : 'تحميل المزيد';
}

function startServices() {
  setupLoadMoreButton();

  watchServices(
    (list, state = {}) => {
      services =
        Array.isArray(list)
          ? list
          : [];

      servicesPageState = {
        hasMore: Boolean(state.hasMore),
        loadingMore: Boolean(state.loadingMore)
      };

      updateCategories();
      render();
      updateLoadMoreButton();
    },
    (error) => {
      console.error(
        'HOME SERVICES ERROR:',
        error
      );

      if (grid) {
        grid.innerHTML = `
          <div class="empty">
            <strong>
              تعذر تحميل الخدمات
            </strong>
            <p>
              حاول تحديث الصفحة مرة أخرى.
            </p>
          </div>
        `;
      }

      servicesPageState = {
        hasMore: false,
        loadingMore: false
      };

      updateLoadMoreButton();
    }
  );
}

onAuthStateChanged(
  auth,
  async (user) => {

    currentUser = user || null;
    favoriteIds = new Set();

    setupAuthUI();

    if (currentUser) {
      try {
        favoriteIds = await loadFavoriteIds(currentUser);
      } catch (error) {
        console.error('LOAD FAVORITES ERROR:', error);
      }
    }

    render();
  }
);

search?.addEventListener('input', () => {
  filterState.query = String(search.value || '').trim();
  syncUrlFromFilters();
  render();
});

category?.addEventListener('change', () => {
  setFilter('category', category.value);
});

sort?.addEventListener('change', () => {
  filterState.sort = sort.value || 'latest';
  syncUrlFromFilters();
  render();
});

readFiltersFromUrl();
syncFilterControls();
setupAdvancedFilters();
setupCategoryChips();
setupLogout();
setupMobileMenu();
startServices();
