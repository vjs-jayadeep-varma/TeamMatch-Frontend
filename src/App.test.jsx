import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'

function apiResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function setupProjectPage({ ownerStudentId = 1, status = 'OPEN' } = {}) {
  let currentStatus = status
  const project = {
    id: 7,
    title: 'TeamMatch Test Project',
    description: 'Closure workflow test',
    ownerStudentId,
    ownerName: 'Owner Student',
    teamLeaderName: 'Owner Student',
    teamName: 'TeamMatch Test Team',
    teamMembers: [],
    requiredTeamSize: 4,
    requiredSkills: [],
    status,
  }
  const fetchMock = vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = options.method ?? 'GET'
    if (path === '/api/auth/me') {
      return apiResponse({
        id: 1,
        name: 'Owner Student',
        email: 'owner@example.com',
        accountRole: 'STUDENT',
      })
    }
    if (path === '/api/csrf') return apiResponse({ token: 'csrf-token', headerName: 'X-CSRF-TOKEN' })
    if (path === '/api/projects' && method === 'GET') {
      return apiResponse([{ ...project, status: currentStatus }])
    }
    if (path === '/api/students/1/skills') return apiResponse([])
    if (path === '/api/projects/7' && method === 'GET') {
      return apiResponse({ ...project, status: currentStatus })
    }
    if (path === '/api/projects/7/close' && method === 'PATCH') {
      currentStatus = 'CANCELLED'
      return apiResponse({ ...project, status: currentStatus })
    }
    return apiResponse({ message: `Unexpected test request: ${method} ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <App />
    </MemoryRouter>,
  )
  return { fetchMock, project }
}

function setupRecommendationPage() {
  const projects = [
    {
      id: 7,
      title: 'Java Application Development',
      description: 'First matching project',
      ownerStudentId: 1,
      status: 'OPEN',
      requiredSkills: [{ id: 11, name: 'Java' }, { id: 22, name: 'Spring' }],
    },
    {
      id: 8,
      title: 'Cloud Platform',
      description: 'Second matching project',
      ownerStudentId: 2,
      status: 'OPEN',
      requiredSkills: [{ id: 11, name: 'Java' }, { id: 22, name: 'Spring' }, { id: 33, name: 'Cloud' }],
    },
  ]
  let firstRecommendationCalls = 0
  const fetchMock = vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = options.method ?? 'GET'
    if (path === '/api/auth/me') {
      return apiResponse({
        id: 1,
        name: 'Owner Student',
        email: 'owner@example.com',
        accountRole: 'STUDENT',
      })
    }
    if (path === '/api/projects' && method === 'GET') return apiResponse(projects)
    if (path === '/api/students/1/skills') {
      return apiResponse([
        { studentId: 1, skillId: 11, skillName: 'Java' },
        { studentId: 1, skillId: 11, skillName: 'Java' },
      ])
    }
    if (/^\/api\/students\/1\/team-requests\/(incoming|outgoing)(\/history)?$/.test(path)) {
      return apiResponse([])
    }
    if (path === '/api/projects/7/recommendations') {
      firstRecommendationCalls += 1
      if (firstRecommendationCalls === 1) {
        return apiResponse({ message: 'Temporary recommendation failure.' }, 400)
      }
      return apiResponse([])
    }
    if (path === '/api/projects/8/recommendations') return apiResponse([])
    return apiResponse({ message: `Unexpected test request: ${method} ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(
    <MemoryRouter initialEntries={['/find-teammates']}>
      <App />
    </MemoryRouter>,
  )
  return { fetchMock }
}

async function signInAndOpenProject() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'View details' }))
  await screen.findByText('Current members:')
  return user
}

describe('owner project closure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('confirms cancellation, calls the close endpoint, and updates the displayed project', async () => {
    const { fetchMock } = setupProjectPage()
    const user = await signInAndOpenProject()

    await user.click(screen.getByRole('button', { name: 'Close project' }))

    expect(window.confirm).toHaveBeenCalledWith(
      'Cancel "TeamMatch Test Project"? Existing members and requests will be preserved.',
    )
    await screen.findByText(/Project cancelled\. Existing members, requests, and invitations were preserved\./)
    expect(screen.getAllByText('CANCELLED').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Close project' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/7/close',
      expect.objectContaining({ method: 'PATCH' }),
    )
    const closeRequest = fetchMock.mock.calls.find(([url]) => url === '/api/projects/7/close')
    expect(closeRequest?.[1].headers.get('X-CSRF-TOKEN')).toBe('csrf-token')
  })

  it('does not expose project closure to a non-owner', async () => {
    setupProjectPage({ ownerStudentId: 2 })
    await signInAndOpenProject()

    expect(screen.queryByRole('button', { name: 'Close project' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Request to join this team' })).toBeTruthy()
  })

  it('does not offer cancellation for a project outside OPEN status', async () => {
    setupProjectPage({ status: 'IN_PROGRESS' })
    await signInAndOpenProject()

    expect(screen.queryByRole('button', { name: 'Close project' })).toBeNull()
  })

  it('leaves the project open when the confirmation is declined', async () => {
    const { fetchMock } = setupProjectPage()
    const user = await signInAndOpenProject()
    vi.mocked(window.confirm).mockReturnValue(false)

    await user.click(screen.getByRole('button', { name: 'Close project' }))

    expect(screen.getAllByText('OPEN').length).toBeGreaterThan(0)
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/7/close',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })
})

describe('recommendation flow and project compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads persisted skills, scores every project, sends selected project ID, and clears stale errors on retry', async () => {
    const user = userEvent.setup()
    const { fetchMock } = setupRecommendationPage()
    const projectSelect = await screen.findByRole('combobox', { name: 'Project' })

    await screen.findByRole('option', { name: /Java Application Development — 50% compatible/ })
    expect(projectSelect.options[1].textContent).toContain('Java Application Development — 50% compatible')
    expect(projectSelect.options[2].textContent).toContain('Cloud Platform — 33% compatible')

    await user.selectOptions(projectSelect, '7')
    expect(await screen.findByText(/Temporary recommendation failure/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No available students match this project yet.')).toBeTruthy()
    expect(screen.queryByText(/Temporary recommendation failure/)).toBeNull()

    await user.selectOptions(projectSelect, '8')
    await screen.findByText('No available students match this project yet.')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/7/recommendations',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/8/recommendations',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/students/1/skills',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/undefined/recommendations'),
      expect.anything(),
    )
  })
})
