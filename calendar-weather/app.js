// ==================== Supabase 数据客户端 ====================
const supabaseConfig = globalThis.FAMILYHUB_SUPABASE_CONFIG || {};
const supabaseUrl = supabaseConfig.url;
const supabaseAnonKey = supabaseConfig.anonKey;
const isSupabaseConfigured = supabaseUrl
    && supabaseAnonKey
    && !supabaseUrl.includes('YOUR_PROJECT_REF')
    && !supabaseAnonKey.includes('YOUR_SUPABASE_ANON_KEY');
const supabaseClient = isSupabaseConfigured && globalThis.supabase
    ? globalThis.supabase.createClient(supabaseUrl, supabaseAnonKey)
    : null;

function requireSupabase() {
    if (!supabaseClient) {
        throw new Error('请先在 supabase-config.js 中配置 Supabase URL 和 anon key');
    }
    return supabaseClient;
}

function throwIfSupabaseError(error) {
    if (error) throw new Error(error.message);
}

function fromDatabase(table, row) {
    if (table === 'family_members') {
        return { ...row, createdAt: row.created_at };
    }
    if (table === 'events') {
        return {
            ...row,
            startTime: row.start_time,
            endTime: row.end_time,
            assigneeId: row.assignee_id,
            createdAt: row.created_at
        };
    }
    if (table === 'todos') {
        return {
            ...row,
            assigneeId: row.assignee_id,
            dueDate: row.due_date,
            completedAt: row.completed_at,
            createdAt: row.created_at
        };
    }
    return {
        ...row,
        assigneeId: row.assignee_id,
        fromRecipe: row.from_recipe,
        createdAt: row.created_at
    };
}

function toDatabase(table, value) {
    const common = { id: value.id, created_at: value.createdAt };
    if (table === 'family_members') {
        return { ...common, name: value.name, color: value.color, role: value.role };
    }
    if (table === 'events') {
        return {
            ...common,
            title: value.title,
            date: value.date,
            start_time: value.startTime || null,
            end_time: value.endTime || null,
            assignee_id: value.assigneeId || null,
            note: value.note || ''
        };
    }
    if (table === 'todos') {
        return {
            ...common,
            content: value.content,
            assignee_id: value.assigneeId || null,
            due_date: value.dueDate || null,
            category: value.category,
            completed: Boolean(value.completed),
            completed_at: value.completedAt || null
        };
    }
    return {
        ...common,
        name: value.name,
        quantity: value.quantity || '',
        assignee_id: value.assigneeId || null,
        purchased: Boolean(value.purchased),
        from_recipe: value.fromRecipe || ''
    };
}

async function loadSupabaseData(client) {
    const [members, events, todos, shopping] = await Promise.all([
        client.from('family_members').select('*').order('created_at'),
        client.from('events').select('*').order('date').order('start_time'),
        client.from('todos').select('*').order('completed').order('created_at', { ascending: false }),
        client.from('shopping_items').select('*').order('purchased').order('created_at')
    ]);
    [members, events, todos, shopping].forEach(result => throwIfSupabaseError(result.error));
    return {
        members: members.data.map(row => fromDatabase('family_members', row)),
        events: events.data.map(row => fromDatabase('events', row)),
        todos: todos.data.map(row => fromDatabase('todos', row)),
        shoppingList: shopping.data.map(row => fromDatabase('shopping_items', row))
    };
}

async function mutateSupabaseData(client, endpoint, method, body) {
    const match = endpoint.match(/^\/(members|events|todos|shopping)(?:\/([^/]+))?(?:\/(toggle))?$/);
    if (!match) throw new Error('未知的数据操作');

    const [, resource, id, action] = match;
    const table = {
        members: 'family_members',
        events: 'events',
        todos: 'todos',
        shopping: 'shopping_items'
    }[resource];

    let result;
    if (method === 'POST') {
        result = await client.from(table).insert(toDatabase(table, body));
    } else if (method === 'DELETE' && id) {
        result = await client.from(table).delete().eq('id', id);
    } else if (method === 'PATCH' && action === 'toggle' && id) {
        const changes = resource === 'todos'
            ? { completed: Boolean(body.completed), completed_at: body.completed ? new Date().toISOString() : null }
            : { purchased: Boolean(body.purchased) };
        result = await client.from(table).update(changes).eq('id', id);
    } else {
        throw new Error('不支持的数据操作');
    }
    throwIfSupabaseError(result.error);
}

async function apiCall(endpoint, options = {}) {
    try {
        const client = requireSupabase();
        const method = options.method || 'GET';
        if (endpoint === '/data' && method === 'GET') {
            return { success: true, data: await loadSupabaseData(client) };
        }
        await mutateSupabaseData(client, endpoint, method, options.body ? JSON.parse(options.body) : null);
        return { success: true };
    } catch (error) {
        console.error('Supabase 操作失败:', error);
        showToast('同步失败: ' + error.message);
        throw error;
    }
}

// ==================== 数据管理 ====================
let appData = {
    members: [],
    events: [],
    todos: [],
    shoppingList: [],
    selectedDate: new Date().toISOString().split('T')[0],
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear()
};

let isLoading = false;
let realtimeRefreshTimer = null;

async function loadData() {
    try {
        isLoading = true;
        const response = await apiCall('/data');
        appData = {
            ...appData,
            members: response.data.members || [],
            events: response.data.events || [],
            todos: response.data.todos || [],
            shoppingList: response.data.shoppingList || []
        };
        return true;
    } catch (error) {
        console.error('加载数据失败:', error);
        return false;
    } finally {
        isLoading = false;
    }
}

function scheduleRealtimeRefresh() {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(() => refreshData(), 150);
}

function subscribeToRealtimeChanges() {
    if (!supabaseClient) return;
    ['family_members', 'events', 'todos', 'shopping_items'].forEach(table => {
        supabaseClient.channel(`familyhub-${table}`)
            .on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRealtimeRefresh)
            .subscribe();
    });
}

const COLOR_PALETTE = [
    '#ef4444', '#f97316', '#eab308', '#22c55e',
    '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
    '#6b7280', '#84cc16', '#14b8a6', '#a855f7'
];

const RECIPES = [
    { id: 'r1', name: '番茄炒蛋', category: 'dinner', time: 15, isQuick: true, icon: '🍳', ingredients: ['番茄 2个', '鸡蛋 3个', '葱花 适量', '盐 适量', '糖 少许'], steps: ['番茄洗净切块，鸡蛋打散加少许盐', '热锅凉油，倒入蛋液炒至凝固盛出', '锅中再加少许油，放入番茄翻炒出汁', '加少许糖提鲜，倒入鸡蛋翻炒均匀', '撒上葱花，出锅'] },
    { id: 'r2', name: '蒜蓉西兰花', category: 'dinner', time: 20, isQuick: true, icon: '🥦', ingredients: ['西兰花 1颗', '大蒜 5瓣', '盐 适量', '蚝油 1勺', '食用油 适量'], steps: ['西兰花切成小朵，用盐水浸泡10分钟', '锅中烧水，加少许盐和油', '放入西兰花焯水2分钟捞出', '热锅凉油，爆香蒜末', '倒入西兰花翻炒，加蚝油和盐调味'] },
    { id: 'r3', name: '麻婆豆腐', category: 'dinner', time: 25, isQuick: true, icon: '🌶️', ingredients: ['嫩豆腐 1盒', '猪肉末 100g', '豆瓣酱 2勺', '花椒粉 适量', '葱姜蒜 适量'], steps: ['豆腐切丁，用盐水焯烫去豆腥味', '热锅凉油，爆香葱姜蒜', '下肉末炒至变色，加豆瓣酱炒出红油', '加入豆腐和适量水，小火炖5分钟', '勾芡，撒花椒粉和葱花'] },
    { id: 'r4', name: '简易三明治', category: 'breakfast', time: 10, isQuick: true, icon: '🥪', ingredients: ['吐司面包 2片', '火腿 2片', '生菜 适量', '番茄 1个', '沙拉酱 适量'], steps: ['吐司面包片烤至微黄', '番茄洗净切片', '在一片面包上依次放生菜、火腿、番茄', '挤上沙拉酱，盖上另一片面包', '对角切开即可'] },
    { id: 'r5', name: '牛奶燕麦粥', category: 'breakfast', time: 15, isQuick: true, icon: '🥣', ingredients: ['燕麦片 50g', '牛奶 250ml', '蜂蜜 适量', '蓝莓 适量', '香蕉 1根'], steps: ['锅中倒入牛奶，小火加热', '加入燕麦片煮5分钟', '盛出后加蜂蜜调味', '放上切好的香蕉片和蓝莓'] },
    { id: 'r6', name: '蛋炒饭', category: 'lunch', time: 20, isQuick: true, icon: '🍚', ingredients: ['隔夜米饭 1碗', '鸡蛋 2个', '胡萝卜 半根', '豌豆 适量', '葱花 适量'], steps: ['鸡蛋打散，胡萝卜切丁', '热油炒蛋至凝固盛出', '锅中再加油，炒胡萝卜和豌豆', '加入米饭炒散，加盐调味', '倒入鸡蛋翻炒，撒葱花'] },
    { id: 'r7', name: '红烧肉', category: 'dinner', time: 90, isQuick: false, icon: '🍖', ingredients: ['五花肉 500g', '冰糖 30g', '生抽 3勺', '老抽 1勺', '料酒 2勺', '八角 2个'], steps: ['五花肉切块，冷水下锅焯水', '锅中放冰糖小火炒至枣红色', '下肉块翻炒上色', '加生抽、老抽、料酒和八角', '加热水没过肉，大火烧开转小火炖1小时', '大火收汁即可'] },
    { id: 'r8', name: '清蒸鲈鱼', category: 'dinner', time: 30, isQuick: true, icon: '🐟', ingredients: ['鲈鱼 1条', '姜丝 适量', '葱丝 适量', '蒸鱼豉油 2勺', '料酒 1勺'], steps: ['鲈鱼处理干净，在鱼身划几刀', '抹上料酒，鱼肚塞姜丝', '水开后大火蒸8-10分钟', '倒掉盘中的汁水', '铺上葱丝，淋上热油和蒸鱼豉油'] },
    { id: 'r9', name: '提拉米苏', category: 'dessert', time: 60, isQuick: false, icon: '🍰', ingredients: ['马斯卡彭奶酪 250g', '手指饼干 1包', '浓缩咖啡 200ml', '可可粉 适量', '鸡蛋 3个'], steps: ['蛋黄加糖打发至浓稠', '加入马斯卡彭奶酪拌匀', '蛋白打发至硬性发泡', '将蛋白霜分次拌入奶酪糊', '手指饼干蘸咖啡铺底层', '一层奶酪糊一层饼干，重复', '冷藏4小时以上，撒可可粉'] },
    { id: 'r10', name: '紫菜蛋花汤', category: 'lunch', time: 10, isQuick: true, icon: '🥣', ingredients: ['紫菜 适量', '鸡蛋 1个', '虾皮 适量', '盐 适量', '香油 几滴'], steps: ['锅中烧水', '水开后放入紫菜和虾皮', '鸡蛋打散，淋入锅中成蛋花', '加盐调味，淋香油', '出锅'] },
    { id: 'r11', name: '糖醋排骨', category: 'dinner', time: 50, isQuick: false, icon: '🍖', ingredients: ['排骨 500g', '醋 3勺', '糖 2勺', '生抽 2勺', '料酒 1勺', '番茄酱 1勺'], steps: ['排骨冷水下锅焯水', '锅中放油炒糖色', '下排骨翻炒上色', '加醋、生抽、料酒、番茄酱', '加热水炖30分钟', '大火收汁'] },
    { id: 'r12', name: '水果沙拉', category: 'dessert', time: 15, isQuick: true, icon: '🥗', ingredients: ['苹果 1个', '香蕉 1根', '橙子 1个', '葡萄 适量', '酸奶 1盒', '蜂蜜 适量'], steps: ['所有水果洗净', '苹果、橙子切块', '香蕉切片', '葡萄对半切开', '所有水果放入碗中', '淋上酸奶和蜂蜜拌匀'] }
];

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function getMemberById(id) {
    return appData.members.find(m => m.id === id);
}

function showToast(message, duration = 2500) {
    const toast = document.getElementById('toast');
    document.getElementById('toastMessage').textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function getTodayStr() {
    return new Date().toISOString().split('T')[0];
}

// ==================== 成员管理 ====================
function openAddMemberModal() {
    document.getElementById('addMemberModal').classList.remove('hidden');
    document.getElementById('memberName').value = '';
    renderColorPicker();
}

function renderColorPicker() {
    const container = document.getElementById('colorPicker');
    const usedColors = appData.members.map(m => m.color);
    const availableColors = COLOR_PALETTE.filter(c => !usedColors.includes(c));

    container.innerHTML = '';
    if (availableColors.length === 0) {
        container.innerHTML = '<p class="col-span-6 text-sm text-gray-500">已使用所有颜色</p>';
        return;
    }

    availableColors.forEach((color, index) => {
        const div = document.createElement('div');
        div.className = 'color-option' + (index === 0 ? ' selected' : '');
        div.style.background = color;
        div.dataset.color = color;
        div.onclick = () => {
            document.querySelectorAll('.color-option').forEach(c => c.classList.remove('selected'));
            div.classList.add('selected');
        };
        container.appendChild(div);
    });
}

async function addMember() {
    const name = document.getElementById('memberName').value.trim();
    const role = document.getElementById('memberRole').value;
    const selectedColor = document.querySelector('.color-option.selected');

    if (!name) { showToast('请输入成员姓名'); return; }
    if (!selectedColor) { showToast('请选择颜色'); return; }

    const member = {
        id: generateId(),
        name, color: selectedColor.dataset.color, role,
        createdAt: new Date().toISOString()
    };

    try {
        await apiCall('/members', { method: 'POST', body: JSON.stringify(member) });
        appData.members.push(member);
        closeModal('addMemberModal');
        renderAll();
        showToast(`${name}已加入家庭`);
    } catch (error) {}
}

async function deleteMember(id) {
    if (!confirm('确定要删除此成员吗？')) return;
    try {
        await apiCall(`/members/${id}`, { method: 'DELETE' });
        appData.members = appData.members.filter(m => m.id !== id);
        appData.events.forEach(e => { if (e.assigneeId === id) e.assigneeId = null; });
        appData.todos.forEach(t => { if (t.assigneeId === id) t.assigneeId = null; });
        appData.shoppingList.forEach(s => { if (s.assigneeId === id) s.assigneeId = null; });
        renderAll();
        showToast('成员已删除');
    } catch (error) {}
}

function openAddEventModal(date = null) {
    document.getElementById('addEventModal').classList.remove('hidden');
    document.getElementById('eventTitle').value = '';
    document.getElementById('eventDate').value = date || appData.selectedDate;
    document.getElementById('eventStartTime').value = '';
    document.getElementById('eventEndTime').value = '';
    document.getElementById('eventNote').value = '';
    renderAssigneeSelect('eventAssignee');
}

function renderAssigneeSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">无</option>';
    appData.members.forEach(m => {
        const option = document.createElement('option');
        option.value = m.id;
        option.textContent = m.name;
        select.appendChild(option);
    });
    select.value = currentValue;
}

async function addEvent() {
    const title = document.getElementById('eventTitle').value.trim();
    const date = document.getElementById('eventDate').value;
    const startTime = document.getElementById('eventStartTime').value;
    const endTime = document.getElementById('eventEndTime').value;
    const assigneeId = document.getElementById('eventAssignee').value;
    const note = document.getElementById('eventNote').value.trim();

    if (!title) { showToast('请输入事件标题'); return; }
    if (!date) { showToast('请选择日期'); return; }

    const event = {
        id: generateId(), title, date, startTime, endTime,
        assigneeId: assigneeId || null, note,
        createdAt: new Date().toISOString()
    };

    try {
        await apiCall('/events', { method: 'POST', body: JSON.stringify(event) });
        appData.events.push(event);
        closeModal('addEventModal');
        renderAll();
        showToast('事件添加成功');
    } catch (error) {}
}

async function deleteEvent(id) {
    if (!confirm('确定要删除此事件吗？')) return;
    try {
        await apiCall(`/events/${id}`, { method: 'DELETE' });
        appData.events = appData.events.filter(e => e.id !== id);
        renderAll();
        showToast('事件已删除');
    } catch (error) {}
}

function openAddTodoModal() {
    if (appData.members.length === 0) { showToast('请先添加家庭成员'); return; }
    document.getElementById('addTodoModal').classList.remove('hidden');
    document.getElementById('todoContent').value = '';
    document.getElementById('todoDueDate').value = '';
    renderAssigneeSelect('todoAssignee');
}

async function addTodo() {
    const content = document.getElementById('todoContent').value.trim();
    const assigneeId = document.getElementById('todoAssignee').value;
    const dueDate = document.getElementById('todoDueDate').value;
    const category = document.getElementById('todoCategory').value;

    if (!content) { showToast('请输入待办内容'); return; }

    const todo = {
        id: generateId(), content,
        assigneeId: assigneeId || null, dueDate: dueDate || null, category,
        completed: false, createdAt: new Date().toISOString()
    };

    try {
        await apiCall('/todos', { method: 'POST', body: JSON.stringify(todo) });
        appData.todos.push(todo);
        closeModal('addTodoModal');
        renderAll();
        showToast('待办添加成功');
    } catch (error) {}
}

async function toggleTodo(id) {
    const todo = appData.todos.find(t => t.id === id);
    if (!todo) return;
    const newCompleted = !todo.completed;
    try {
        await apiCall(`/todos/${id}/toggle`, {
            method: 'PATCH',
            body: JSON.stringify({ completed: newCompleted })
        });
        todo.completed = newCompleted;
        todo.completedAt = newCompleted ? new Date().toISOString() : null;
        renderAll();
    } catch (error) {}
}

async function deleteTodo(id) {
    if (!confirm('确定要删除此待办吗？')) return;
    try {
        await apiCall(`/todos/${id}`, { method: 'DELETE' });
        appData.todos = appData.todos.filter(t => t.id !== id);
        renderAll();
        showToast('待办已删除');
    } catch (error) {}
}

function openAddShoppingItemModal() {
    document.getElementById('addShoppingItemModal').classList.remove('hidden');
    document.getElementById('shoppingItem').value = '';
    document.getElementById('shoppingQuantity').value = '';
    renderAssigneeSelect('shoppingAssignee');
}

async function addShoppingItemFromForm() {
    const name = document.getElementById('shoppingItem').value.trim();
    const quantity = document.getElementById('shoppingQuantity').value.trim();
    const assigneeId = document.getElementById('shoppingAssignee').value;

    if (!name) { showToast('请输入商品名'); return; }

    const item = {
        id: generateId(), name,
        quantity: quantity || '',
        assigneeId: assigneeId || null,
        fromRecipe: '',
        purchased: false, createdAt: new Date().toISOString()
    };

    try {
        await apiCall('/shopping', { method: 'POST', body: JSON.stringify(item) });
        appData.shoppingList.push(item);
        closeModal('addShoppingItemModal');
        renderAll();
        showToast('商品已加入清单');
    } catch (error) {}
}

async function toggleShoppingItem(id) {
    const item = appData.shoppingList.find(s => s.id === id);
    if (!item) return;
    const newPurchased = !item.purchased;
    try {
        await apiCall(`/shopping/${id}/toggle`, {
            method: 'PATCH',
            body: JSON.stringify({ purchased: newPurchased })
        });
        item.purchased = newPurchased;
        renderAll();
    } catch (error) {}
}

async function deleteShoppingItem(id) {
    if (!confirm('确定要从清单中移除吗？')) return;
    try {
        await apiCall(`/shopping/${id}`, { method: 'DELETE' });
        appData.shoppingList = appData.shoppingList.filter(s => s.id !== id);
        renderAll();
    } catch (error) {}
}

function filterRecipes() { renderRecipes(); }

function getFilteredRecipes() {
    const filter = document.getElementById('recipeFilter').value;
    if (filter === 'all') return RECIPES;
    if (filter === 'quick') return RECIPES.filter(r => r.isQuick);
    return RECIPES.filter(r => r.category === filter);
}

function renderRecipes() {
    const container = document.getElementById('recipeGrid');
    const recipes = getFilteredRecipes();
    if (recipes.length === 0) {
        container.innerHTML = '<p class="col-span-full text-center text-gray-500 py-8">没有符合条件的食谱</p>';
        return;
    }
    container.innerHTML = recipes.map(recipe => `
        <div class="recipe-card" onclick="openRecipeDetail('${recipe.id}')">
            <div class="recipe-image">${recipe.icon}</div>
            <div class="recipe-content">
                <div class="recipe-title">${recipe.name}</div>
                <div class="recipe-meta">
                    <span>${recipe.time}分钟</span>
                    <span>${getCategoryName(recipe.category)}</span>
                </div>
                <div>${recipe.isQuick ? '<span class="recipe-tag quick">快手菜</span>' : ''}</div>
            </div>
        </div>
    `).join('');
}

function getCategoryName(category) {
    const names = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', dessert: '甜点' };
    return names[category] || category;
}

function openRecipeDetail(recipeId) {
    const recipe = RECIPES.find(r => r.id === recipeId);
    if (!recipe) return;
    document.getElementById('recipeDetailTitle').textContent = recipe.name;
    document.getElementById('recipeDetailContent').innerHTML = `
        <div class="space-y-4">
            <div class="bg-gradient-to-r from-yellow-100 to-orange-100 rounded-xl p-6 text-center">
                <div class="text-6xl mb-2">${recipe.icon}</div>
                <h4 class="text-2xl font-bold text-gray-800">${recipe.name}</h4>
                <div class="flex items-center justify-center space-x-4 mt-2 text-sm text-gray-600">
                    <span>${recipe.time}分钟</span>
                    <span>${getCategoryName(recipe.category)}</span>
                    ${recipe.isQuick ? '<span class="recipe-tag quick">快手菜</span>' : ''}
                </div>
            </div>
            <div>
                <h5 class="font-semibold text-gray-800 mb-2">所需食材</h5>
                <ul class="space-y-1 bg-gray-50 rounded-lg p-3">
                    ${recipe.ingredients.map(i => `<li class="text-sm text-gray-700">• ${i}</li>`).join('')}
                </ul>
            </div>
            <div>
                <h5 class="font-semibold text-gray-800 mb-2">制作步骤</h5>
                <ol class="space-y-2 bg-gray-50 rounded-lg p-3">
                    ${recipe.steps.map((s, i) => `
                        <li class="text-sm text-gray-700 flex">
                            <span class="flex-shrink-0 w-5 h-5 bg-blue-500 text-white text-xs rounded-full flex items-center justify-center mr-2 mt-0.5">${i + 1}</span>
                            <span>${s}</span>
                        </li>
                    `).join('')}
                </ol>
            </div>
            <button onclick="addRecipeToShoppingList('${recipe.id}')" class="w-full py-3 bg-gradient-to-r from-orange-500 to-pink-500 text-white rounded-lg hover:shadow-lg transition">
                加入购物清单
            </button>
        </div>
    `;
    document.getElementById('recipeDetailModal').classList.remove('hidden');
}

async function addRecipeToShoppingList(recipeId) {
    const recipe = RECIPES.find(r => r.id === recipeId);
    if (!recipe) return;

    showToast('正在加入购物清单...');
    let count = 0;
    for (const ing of recipe.ingredients) {
        const item = {
            id: generateId(), name: ing,
            quantity: '', assigneeId: null,
            fromRecipe: recipe.name,
            purchased: false, createdAt: new Date().toISOString()
        };
        try {
            await apiCall('/shopping', { method: 'POST', body: JSON.stringify(item) });
            appData.shoppingList.push(item);
            count++;
        } catch (error) {
            break;
        }
    }
    closeModal('recipeDetailModal');
    renderAll();
    showToast(`已加入${count}项食材到购物清单`);
}

function renderAll() {
    renderMemberAvatars();
    renderDashboard();
    renderCalendar();
    renderTodos();
    renderShoppingList();
    renderRecipes();
}

function renderMemberAvatars() {
    const container = document.getElementById('memberAvatars');
    container.innerHTML = '';
    if (appData.members.length === 0) {
        container.innerHTML = '<span class="text-sm text-gray-500">还没有家庭成员</span>';
        return;
    }
    appData.members.forEach(member => {
        const avatar = document.createElement('div');
        avatar.className = 'member-avatar';
        avatar.style.background = member.color;
        avatar.textContent = member.name.charAt(0).toUpperCase();
        avatar.title = `${member.name} - 点击删除`;
        avatar.onclick = () => {
            if (confirm(`确定要删除成员"${member.name}"吗？`)) {
                deleteMember(member.id);
            }
        };
        container.appendChild(avatar);
    });
}

function renderDashboard() {
    const today = getTodayStr();
    const todayEvents = appData.events.filter(e => e.date === today);
    const pendingTodos = appData.todos.filter(t => !t.completed);

    document.getElementById('todayEventCount').textContent = todayEvents.length;
    document.getElementById('todoCount').textContent = pendingTodos.length;
    document.getElementById('shoppingCount').textContent = appData.shoppingList.filter(s => !s.purchased).length;
    document.getElementById('memberCount').textContent = appData.members.length;

    const hour = new Date().getHours();
    let greeting = '欢迎使用 FamilyHub';
    if (hour < 6) greeting = '夜深了，注意休息';
    else if (hour < 12) greeting = '早上好';
    else if (hour < 18) greeting = '下午好';
    else greeting = '晚上好';
    document.getElementById('greeting').textContent = greeting;

    const todayStr = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    let summary = `${todayStr} · `;
    if (todayEvents.length === 0 && pendingTodos.length === 0) {
        summary += '今天可以好好休息了';
    } else {
        const parts = [];
        if (todayEvents.length > 0) parts.push(`${todayEvents.length}个事件`);
        if (pendingTodos.length > 0) parts.push(`${pendingTodos.length}个待办`);
        summary += `今天有${parts.join('、')}`;
    }
    document.getElementById('todaySummary').textContent = summary;

    const todayEventsContainer = document.getElementById('todayEvents');
    if (todayEvents.length === 0) {
        todayEventsContainer.innerHTML = '<p class="text-gray-500 text-sm">今日暂无安排</p>';
    } else {
        todayEventsContainer.innerHTML = todayEvents
            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
            .map(event => {
                const member = event.assigneeId ? getMemberById(event.assigneeId) : null;
                const color = member ? member.color : '#6b7280';
                return `
                    <div class="flex items-center p-2 rounded-lg hover:bg-gray-50" style="border-left: 3px solid ${color}">
                        <div class="flex-1">
                            <div class="font-medium text-sm text-gray-800">${event.title}</div>
                            <div class="text-xs text-gray-500">${event.startTime || '全天'}${event.endTime ? ' - ' + event.endTime : ''}</div>
                        </div>
                        ${member ? `<span class="text-xs px-2 py-0.5 rounded-full text-white" style="background:${color}">${member.name}</span>` : ''}
                    </div>
                `;
            }).join('');
    }

    const pendingTodosContainer = document.getElementById('pendingTodos');
    if (pendingTodos.length === 0) {
        pendingTodosContainer.innerHTML = '<p class="text-gray-500 text-sm">暂无待办事项</p>';
    } else {
        pendingTodosContainer.innerHTML = pendingTodos.slice(0, 5).map(todo => {
            const member = todo.assigneeId ? getMemberById(todo.assigneeId) : null;
            const color = member ? member.color : '#6b7280';
            return `
                <div class="flex items-center p-2 rounded-lg hover:bg-gray-50">
                    <div class="todo-checkbox ${todo.completed ? 'checked' : ''}" onclick="toggleTodo('${todo.id}')"></div>
                    <div class="flex-1 ml-2">
                        <div class="text-sm text-gray-800">${todo.content}</div>
                        ${todo.dueDate ? `<div class="text-xs text-gray-500">截止：${formatDate(todo.dueDate)}</div>` : ''}
                    </div>
                    ${member ? `<span class="text-xs px-2 py-0.5 rounded-full text-white" style="background:${color}">${member.name}</span>` : ''}
                </div>
            `;
        }).join('');
    }
}

function renderCalendar() {
    const year = appData.currentYear;
    const month = appData.currentMonth;
    document.getElementById('calendarTitle').textContent = `${year}年${month + 1}月`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const today = getTodayStr();
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';

    for (let i = firstDay - 1; i >= 0; i--) {
        const day = daysInPrevMonth - i;
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        grid.appendChild(createCalendarDay(day, dateStr, true));
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        grid.appendChild(createCalendarDay(day, dateStr, false, dateStr === today, dateStr === appData.selectedDate));
    }

    const totalCells = firstDay + daysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let day = 1; day <= remainingCells; day++) {
        const dateStr = `${year}-${String(month + 2).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        grid.appendChild(createCalendarDay(day, dateStr, true));
    }
}

function createCalendarDay(day, dateStr, isOtherMonth, isToday = false, isSelected = false) {
    const div = document.createElement('div');
    div.className = 'calendar-day';
    if (isOtherMonth) div.classList.add('other-month');
    if (isToday) div.classList.add('today');
    if (isSelected) div.classList.add('selected');
    div.onclick = () => selectDate(dateStr);

    const dayEvents = appData.events.filter(e => e.date === dateStr);
    const eventsHtml = dayEvents.slice(0, 3).map(event => {
        const member = event.assigneeId ? getMemberById(event.assigneeId) : null;
        const color = member ? member.color : '#6b7280';
        return `<div class="event-tag" style="background:${color}" title="${event.title}">${event.startTime ? event.startTime + ' ' : ''}${event.title}</div>`;
    }).join('');
    const moreText = dayEvents.length > 3 ? `<div class="event-tag" style="background:#9ca3af">+${dayEvents.length - 3}更多</div>` : '';

    div.innerHTML = `<div class="day-number">${day}</div>${eventsHtml}${moreText}`;
    return div;
}

function selectDate(dateStr) {
    appData.selectedDate = dateStr;
    renderCalendar();
    openAddEventModal(dateStr);
}

function changeMonth(delta) {
    appData.currentMonth += delta;
    if (appData.currentMonth < 0) { appData.currentMonth = 11; appData.currentYear--; }
    else if (appData.currentMonth > 11) { appData.currentMonth = 0; appData.currentYear++; }
    renderCalendar();
}

function goToday() {
    const now = new Date();
    appData.currentYear = now.getFullYear();
    appData.currentMonth = now.getMonth();
    appData.selectedDate = getTodayStr();
    renderCalendar();
}

function renderTodos() {
    const container = document.getElementById('todoByMember');
    if (appData.members.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-8">请先添加家庭成员</p>';
        return;
    }

    let html = '';
    appData.members.forEach(member => {
        const memberTodos = appData.todos.filter(t => t.assigneeId === member.id);
        if (memberTodos.length > 0) {
            html += renderTodoGroup(member, memberTodos);
        }
    });

    const miscTodos = appData.todos.filter(t => t.category === 'misc' && !t.assigneeId);
    if (miscTodos.length > 0) {
        html += renderTodoGroup(null, miscTodos, '杂物');
    }

    if (html === '') {
        html = '<p class="text-gray-500 text-center py-8">还没有待办事项，点击右上角添加</p>';
    }
    container.innerHTML = html;
}

function renderTodoGroup(member, todos, customName = null) {
    const color = member ? member.color : '#6b7280';
    const name = customName || (member ? member.name : '未分配');
    return `
        <div class="bg-gray-50 rounded-xl p-4">
            <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
                ${member ? `<div class="w-6 h-6 rounded-full mr-2 flex items-center justify-center text-white text-xs" style="background:${color}">${member.name.charAt(0)}</div>` : ''}
                ${name}的待办 (${todos.filter(t => !t.completed).length})
            </h4>
            <div class="space-y-2">
                ${todos.map(todo => `
                    <div class="todo-item ${todo.completed ? 'completed' : ''}" style="border-left-color:${color}">
                        <div class="todo-checkbox ${todo.completed ? 'checked' : ''}" onclick="toggleTodo('${todo.id}')"></div>
                        <div class="flex-1">
                            <div class="text-sm text-gray-800">${todo.content}</div>
                            ${todo.dueDate ? `<div class="text-xs text-gray-500">截止：${formatDate(todo.dueDate)}</div>` : ''}
                        </div>
                        <button onclick="deleteTodo('${todo.id}')" class="text-gray-400 hover:text-red-500 ml-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                        </button>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderShoppingList() {
    const container = document.getElementById('shoppingList');
    if (appData.shoppingList.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-8">购物清单是空的</p>';
        return;
    }

    const pending = appData.shoppingList.filter(s => !s.purchased);
    const purchased = appData.shoppingList.filter(s => s.purchased);
    let html = '';

    if (pending.length > 0) {
        html += '<h4 class="font-semibold text-gray-800 mb-3">待采购</h4>';
        html += pending.map(item => {
            const member = item.assigneeId ? getMemberById(item.assigneeId) : null;
            return `
                <div class="shopping-item">
                    <div class="todo-checkbox ${item.purchased ? 'checked' : ''}" onclick="toggleShoppingItem('${item.id}')"></div>
                    <div class="flex-1">
                        <div class="font-medium text-sm text-gray-800">${item.name}</div>
                        ${item.quantity ? `<div class="text-xs text-gray-500">数量：${item.quantity}</div>` : ''}
                        ${item.fromRecipe ? `<div class="text-xs text-orange-600">来自食谱：${item.fromRecipe}</div>` : ''}
                    </div>
                    ${member ? `<span class="text-xs px-2 py-0.5 rounded-full text-white mr-2" style="background:${member.color}">${member.name}</span>` : ''}
                    <button onclick="deleteShoppingItem('${item.id}')" class="text-gray-400 hover:text-red-500">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');
    }

    if (purchased.length > 0) {
        html += '<h4 class="font-semibold text-gray-800 mb-3 mt-6">已采购</h4>';
        html += purchased.map(item => `
            <div class="shopping-item purchased">
                <div class="todo-checkbox checked" onclick="toggleShoppingItem('${item.id}')"></div>
                <div class="flex-1">
                    <div class="font-medium text-sm text-gray-800">${item.name}</div>
                </div>
                <button onclick="deleteShoppingItem('${item.id}')" class="text-gray-400 hover:text-red-500">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                    </svg>
                </button>
            </div>
        `).join('');
    }

    if (pending.length === 0 && purchased.length > 0) {
        html += '<p class="text-green-600 text-sm text-center mt-4">所有商品已采购完成</p>';
    }

    container.innerHTML = html;
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabName).classList.remove('hidden');
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

async function refreshData() {
    if (isLoading) return;
    await loadData();
    renderAll();
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    renderAll();
    switchTab('dashboard');
    subscribeToRealtimeChanges();

    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshData();
    });
});

window.openAddMemberModal = openAddMemberModal;
window.addMember = addMember;
window.deleteMember = deleteMember;
window.openAddEventModal = openAddEventModal;
window.addEvent = addEvent;
window.deleteEvent = deleteEvent;
window.openAddTodoModal = openAddTodoModal;
window.addTodo = addTodo;
window.toggleTodo = toggleTodo;
window.deleteTodo = deleteTodo;
window.openAddShoppingItemModal = openAddShoppingItemModal;
window.addShoppingItemFromForm = addShoppingItemFromForm;
window.toggleShoppingItem = toggleShoppingItem;
window.deleteShoppingItem = deleteShoppingItem;
window.openRecipeDetail = openRecipeDetail;
window.addRecipeToShoppingList = addRecipeToShoppingList;
window.filterRecipes = filterRecipes;
window.switchTab = switchTab;
window.closeModal = closeModal;
window.changeMonth = changeMonth;
window.goToday = goToday;
window.selectDate = selectDate;
window.refreshData = refreshData;
