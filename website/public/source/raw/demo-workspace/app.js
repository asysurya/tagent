// TaskFlow — vanilla JS todo app (demo workspace for Tagent)

const KEY = 'taskflow.tasks'

/** @type {{id: number, text: string, done: boolean}[]} */
let tasks = load()

// Pastikan semua elemen DOM ada sebelum digunakan
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('new-task-form')
  const input = document.getElementById('new-task-input')
  const list = document.getElementById('task-list')
  const countEl = document.getElementById('task-count')
  const clearBtn = document.getElementById('clear-completed')
  
  if (!form || !input || !list || !countEl || !clearBtn) {
    console.error('Required DOM elements not found')
    return
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? []
    } catch {
      return []
    }
  }

  function save() {
    localStorage.setItem(KEY, JSON.stringify(tasks))
  }

  function addTask(text) {
    tasks.push({ id: Date.now(), text: text.trim(), done: false })
    save()
    renderTasks()
  }

  function toggleTask(id) {
    const t = tasks.find((t) => t.id === id)
    if (t) {
      t.done = !t.done
      save()
      renderTasks()
    }
  }

  function deleteTask(id) {
    tasks = tasks.filter((t) => t.id !== id)
    save()
    renderTasks()
  }

  function renderTasks() {
    list.innerHTML = ''
    
    // Update task count
    const activeTasks = tasks.filter(task => !task.done).length
    countEl.textContent = `${activeTasks} tasks left`
    
    for (const task of tasks) {
      const li = document.createElement('li')
      if (task.done) li.classList.add('done')

      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = task.done
      check.addEventListener('change', () => toggleTask(task.id))

      const label = document.createElement('label')
      label.textContent = task.text
      label.addEventListener('click', () => toggleTask(task.id))

      const del = document.createElement('button')
      del.className = 'delete'
      del.textContent = '×'
      del.setAttribute('aria-label', 'Delete task')
      del.addEventListener('click', () => deleteTask(task.id))

      li.append(check, label, del)
      list.appendChild(li)
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (input.value.trim()) {
      addTask(input.value)
      input.value = ''
    }
  })

  clearBtn.addEventListener('click', () => {
    tasks = tasks.filter(task => !task.done)
    save()
    renderTasks()
  })

  renderTasks()
})
