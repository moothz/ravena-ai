document.addEventListener('DOMContentLoaded', () => {
    const loadingList = document.getElementById('loading-list');
    const listContainer = document.getElementById('fishing-list-container');
    const noRecords = document.getElementById('no-records');
    const sortButtons = document.querySelectorAll('.btn-sort');

    let catches = [];

    // Format timestamp to date string
    function formatDate(timestamp) {
        const date = new Date(timestamp);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${minutes}`;
    }

    // Fetch catches from API
    async function fetchCatches() {
        try {
            const response = await fetch('/api/fishing/legendary');
            if (!response.ok) {
                throw new Error('Failed to fetch legendary catches');
            }
            catches = await response.json();
            
            loadingList.style.display = 'none';
            if (catches.length === 0) {
                noRecords.style.display = 'block';
                listContainer.style.display = 'none';
            } else {
                noRecords.style.display = 'none';
                listContainer.style.display = 'flex';
                // Standard sorting by weight desc is already done in backend, but let's make sure
                sortCatches('weight', 'desc');
                renderList();
            }
        } catch (error) {
            console.error('Error fetching catches:', error);
            loadingList.innerHTML = `<p style="color: #ed8936; text-align: center;"><i class="fas fa-exclamation-triangle"></i> Erro ao carregar registros: ${error.message}</p>`;
        }
    }

    // Render the list of catches
    function renderList() {
        listContainer.innerHTML = '';
        
        catches.forEach(item => {
            const groupName = (!item.group_name || item.group_name === 'chat privado') ? 'Privado' : item.group_name;
            const dateStr = formatDate(item.timestamp);
            
            const fishingItem = document.createElement('div');
            fishingItem.className = 'fishing-item';
            
            fishingItem.innerHTML = `
                <div class="fishing-item-header" data-image="${item.image_name}">
                    <div class="fish-info">
                        <div class="fish-title-row">
                            <span class="fish-title">${item.fish_name}</span>
                            <span class="fish-weight">${item.weight.toFixed(2)} kg</span>
                        </div>
                        <div class="fish-meta">
                            <span><i class="fas fa-user"></i> ${item.user_name}</span>
                            <span><i class="fas fa-users"></i> ${groupName}</span>
                            <span><i class="fas fa-calendar-alt"></i> ${dateStr}</span>
                        </div>
                    </div>
                    <i class="fas fa-chevron-down expand-icon"></i>
                </div>
                <div class="fishing-item-content">
                    <div class="image-wrapper">
                        <div class="image-loader">
                            <i class="fas fa-spinner fa-spin"></i>
                            <span>Carregando imagem...</span>
                        </div>
                        <img class="fish-image" alt="${item.fish_name}">
                    </div>
                </div>
            `;
            
            // Toggle accordion expand/collapse
            const header = fishingItem.querySelector('.fishing-item-header');
            header.addEventListener('click', () => {
                const isExpanded = fishingItem.classList.contains('expanded');
                
                // Collapse all other items
                document.querySelectorAll('.fishing-item.expanded').forEach(openItem => {
                    if (openItem !== fishingItem) {
                        openItem.classList.remove('expanded');
                    }
                });
                
                if (isExpanded) {
                    fishingItem.classList.remove('expanded');
                } else {
                    fishingItem.classList.add('expanded');
                    
                    // Lazy-load image if not already loaded
                    const img = fishingItem.querySelector('.fish-image');
                    const loader = fishingItem.querySelector('.image-loader');
                    const imageName = header.getAttribute('data-image');
                    
                    if (!img.src) {
                        img.src = `/api/fishing/image/${imageName}`;
                        img.onload = () => {
                            loader.style.display = 'none';
                            img.style.display = 'block';
                        };
                        img.onerror = () => {
                            loader.innerHTML = '<i class="fas fa-exclamation-circle" style="color: #ff4444;"></i> <span style="color: #ff4444; font-size: 0.9rem;">Imagem não encontrada no servidor</span>';
                        };
                    }
                }
            });
            
            listContainer.appendChild(fishingItem);
        });
    }

    // Sort catches
    function sortCatches(field, order) {
        catches.sort((a, b) => {
            let valA, valB;
            
            switch (field) {
                case 'weight':
                    valA = a.weight;
                    valB = b.weight;
                    break;
                case 'date':
                    valA = a.timestamp;
                    valB = b.timestamp;
                    break;
                case 'name':
                    valA = a.fish_name.toLowerCase();
                    valB = b.fish_name.toLowerCase();
                    break;
                case 'user':
                    valA = a.user_name.toLowerCase();
                    valB = b.user_name.toLowerCase();
                    break;
                default:
                    valA = a.weight;
                    valB = b.weight;
            }
            
            if (typeof valA === 'string') {
                return order === 'asc' 
                    ? valA.localeCompare(valB) 
                    : valB.localeCompare(valA);
            } else {
                return order === 'asc'
                    ? valA - valB
                    : valB - valA;
            }
        });
    }

    // Sort buttons event listeners
    sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const sortBy = button.getAttribute('data-sort');
            let order = button.getAttribute('data-order');
            
            // If already active, toggle order
            if (button.classList.contains('active')) {
                order = order === 'asc' ? 'desc' : 'asc';
                button.setAttribute('data-order', order);
            } else {
                // Remove active class from all
                sortButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
            }
            
            // Update icons on all buttons
            sortButtons.forEach(btn => {
                const isCurrent = btn === button;
                const currentBtnOrder = btn.getAttribute('data-order');
                const sortType = btn.getAttribute('data-sort');
                let iconClass = '';
                
                if (sortType === 'name' || sortType === 'user') {
                    iconClass = currentBtnOrder === 'asc' ? 'fa-sort-alpha-down' : 'fa-sort-alpha-up';
                } else {
                    iconClass = currentBtnOrder === 'asc' ? 'fa-sort-amount-up' : 'fa-sort-amount-down';
                }
                
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.className = `fas ${iconClass}`;
                }
            });
            
            sortCatches(sortBy, order);
            renderList();
        });
    });

    // Start loading
    fetchCatches();
});
