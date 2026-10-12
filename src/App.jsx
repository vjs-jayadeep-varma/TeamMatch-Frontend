import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import heroImage from './assets/hero.png'
import { getProjectCompatibilityLabel } from './projectCompatibility.js'
import './App.css'

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function encodeBasicCredentials(credentials) {
  const bytes = new TextEncoder().encode(`${credentials.username}:${credentials.password}`)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return `Basic ${btoa(binary)}`
}

async function fetchApiJson(
  path,
  signal,
  resource,
  credentials,
  { method = 'GET', body, headers: additionalHeaders = {}, handleUnauthorized = true } = {},
) {
  let response

  try {
    const headers = new Headers({ Accept: 'application/json' })
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json')
    }
    if (credentials) {
      headers.set('Authorization', encodeBasicCredentials(credentials))
    }
    Object.entries(additionalHeaders).forEach(([name, value]) => headers.set(name, value))
    response = await fetch(
  `${import.meta.env.VITE_API_BASE_URL || ''}${path}`,
  {
      method,
      headers,
      signal,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    throw new Error(
      `Could not connect to the TeamMatch backend while requesting ${resource}. Make sure it is running at http://localhost:8080.`,
    )
  }

  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    let responseMessage = ''
    try {
      const responseText = await response.text()
      if (responseText) {
        try {
          const errorBody = JSON.parse(responseText)
          responseMessage = errorBody.detail || errorBody.message || errorBody.title || ''
        } catch {
          responseMessage = responseText.slice(0, 300)
        }
      }
    } catch {
      responseMessage = ''
    }
    if (response.status === 401) {
      const isPublicRequest = path === '/api/csrf'
        || (method === 'POST' && (path === '/api/auth/login' || path === '/api/students'))
      if (path === '/api/auth/login') {
        throw new ApiError(
          responseMessage || 'Email or password is incorrect, or the account is not configured to sign in.',
          response.status,
        )
      }
      if (handleUnauthorized && !isPublicRequest && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('teammatch:unauthorized'))
      }
      throw new ApiError(
        credentials && !isPublicRequest
          ? `The backend rejected the supplied credentials for ${resource} (${status}).`
          : isPublicRequest || !handleUnauthorized
            ? `Could not request ${resource}: the backend returned ${status}.${responseMessage ? ` ${responseMessage}` : ''}`
            : `Your session is not authorized to access ${resource} (${status}). Sign in again and retry.`,
        response.status,
      )
    }
    if (response.status === 403) {
      throw new ApiError(
        `The backend denied access to ${resource} (${status}).${responseMessage ? ` ${responseMessage}` : ''}`,
        response.status,
      )
    }
    throw new ApiError(
      `Could not request ${resource}: the backend returned ${status}.${responseMessage ? ` ${responseMessage}` : ''}`,
      response.status,
    )
  }

  if (response.status === 204) {
    return null
  }

  try {
    return await response.json()
  } catch {
    throw new Error(`The backend returned an invalid JSON response while loading ${resource}.`)
  }
}

async function fetchApiMutation(path, resource, credentials, options = {}) {
  const csrf = await fetchApiJson('/api/csrf', undefined, 'CSRF token', credentials, {
    handleUnauthorized: false,
  })
  if (
    csrf === null ||
    typeof csrf !== 'object' ||
    typeof csrf.token !== 'string' ||
    typeof csrf.headerName !== 'string'
  ) {
    throw new Error('The backend returned an invalid CSRF token response.')
  }

  return fetchApiJson(path, options.signal, resource, credentials, {
    ...options,
    headers: {
      ...options.headers,
      [csrf.headerName]: csrf.token,
    },
  })
}

function sessionRestoreErrorMessage(error) {
  if (error instanceof ApiError && error.status === 403) {
    return 'Access to your student session was denied. Sign in with a registered student account or contact an administrator.'
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'The backend returned 404 for /api/auth/me. The running server may be outdated or a different service may be answering on port 8080; restart the Spring Boot backend and retry.'
  }
  if (error instanceof ApiError && error.status >= 500) {
    return `The backend could not restore your student session (${error.status}). Retry in a moment.`
  }
  return error instanceof Error
    ? error.message
    : 'Could not restore your student session. Check that the backend is running, then retry.'
}

function BackendSignInForm() {
  return (
    <div className="api-auth-form" role="group" aria-label="Backend sign in">
      <p>Your student session may have expired. Sign in with your registered student account to continue.</p>
      <NavLink className="secondary-button" to="/login">Go to sign in</NavLink>
    </div>
  )
}

function CreateProjectModal({
  currentStudent,
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
  onClose,
  editingProject = null,
  onSaved,
}) {
  const navigate = useNavigate()
  const [skills, setSkills] = useState([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [skillsError, setSkillsError] = useState('')
  const [skillsAuthRequired, setSkillsAuthRequired] = useState(false)
  const [skillsRetryKey, setSkillsRetryKey] = useState(0)
  const [title, setTitle] = useState(editingProject?.title ?? '')
  const [description, setDescription] = useState(editingProject?.description ?? '')
  const ownerStudentId = String(currentStudent.id)
  const [requiredTeamSize, setRequiredTeamSize] = useState(String(editingProject?.requiredTeamSize ?? 2))
  const [requiredSkillIds, setRequiredSkillIds] = useState(
    (editingProject?.requiredSkills ?? []).map((skill) => skill.id),
  )
  const [fieldErrors, setFieldErrors] = useState({})
  const [submitError, setSubmitError] = useState('')
  const [submitAuthRequired, setSubmitAuthRequired] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const controller = new AbortController()

    async function loadSkills() {
      setSkillsLoading(true)
      setSkillsError('')
      setSkillsAuthRequired(false)

      try {
        const data = await fetchApiJson('/api/skills', controller.signal, 'available skills', authCredentials)
        if (!Array.isArray(data)) {
          throw new Error('The backend returned an invalid skills response: expected a list.')
        }
        setSkills(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setSkillsAuthRequired(
          loadError instanceof ApiError && loadError.status === 401 && !authCredentials,
        )
        setSkillsError(
          loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading skills.',
        )
      } finally {
        if (!controller.signal.aborted) {
          setSkillsLoading(false)
        }
      }
    }

    loadSkills()
    return () => controller.abort()
  }, [authCredentials, skillsRetryKey])

  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape' && !submitting) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose, submitting])

  function handleSubmit(event) {
    event.preventDefault()
    const errors = {}
    const trimmedTitle = title.trim()
    const trimmedDescription = description.trim()
    const ownerId = Number(ownerStudentId)
    const teamSize = Number(requiredTeamSize)

    if (!trimmedTitle) {
      errors.title = 'Enter a project title.'
    } else if (trimmedTitle.length > 150) {
      errors.title = 'Project titles must be 150 characters or fewer.'
    }
    if (!trimmedDescription) {
      errors.description = 'Enter a project description.'
    } else if (trimmedDescription.length > 2000) {
      errors.description = 'Descriptions must be 2,000 characters or fewer.'
    }
    if (!Number.isInteger(teamSize) || teamSize < 2 || teamSize > 20) {
      errors.requiredTeamSize = 'Team size must be a whole number from 2 to 20.'
    }
    if (requiredSkillIds.length > 20) {
      errors.requiredSkillIds = 'Select no more than 20 skills.'
    }

    setFieldErrors(errors)
    setSubmitError('')
    setSubmitAuthRequired(false)
    if (Object.keys(errors).length > 0) {
      return
    }

    async function createProject() {
      setSubmitting(true)
      try {
        const project = await fetchApiMutation(
          editingProject ? `/api/projects/${encodeURIComponent(editingProject.id)}` : '/api/projects',
          editingProject ? 'project update' : 'project creation',
          authCredentials,
          {
          method: editingProject ? 'PUT' : 'POST',
          body: {
            title: trimmedTitle,
            description: trimmedDescription,
            ownerStudentId: ownerId,
            requiredTeamSize: teamSize,
            requiredSkillIds,
          },
          },
        )
        if (project === null || typeof project !== 'object' || project.id == null) {
          throw new Error('The backend accepted the project change but returned invalid project data.')
        }
        if (editingProject) {
          onSaved?.(project)
          onClose()
        } else {
          navigate('/projects', { state: { createdProject: project } })
          onClose()
        }
      } catch (createError) {
        if (createError instanceof Error && createError.name === 'AbortError') {
          return
        }
        setSubmitAuthRequired(
          createError instanceof ApiError && createError.status === 401 && !authCredentials,
        )
        setSubmitError(
          createError instanceof Error
            ? createError.message
            : 'An unexpected error occurred while creating the project.',
        )
      } finally {
        setSubmitting(false)
      }
    }

    createProject()
  }

  function updateRequiredSkills(event) {
    setRequiredSkillIds(Array.from(event.target.selectedOptions, (option) => Number(option.value)))
    setFieldErrors((errors) => ({ ...errors, requiredSkillIds: undefined }))
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose()
        }
      }}
    >
      <section aria-labelledby="create-project-title" aria-modal="true" className="create-project-modal" role="dialog">
        <div className="section-header">
          <div>
            <p className="eyebrow">{editingProject ? 'Edit project' : 'New project'}</p>
            <h2 id="create-project-title">{editingProject ? 'Update project' : 'Create a project'}</h2>
          </div>
          <button
            aria-label="Close project form"
            className="text-button"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <form className="create-project-form" noValidate onSubmit={handleSubmit}>
            <label>
              Project title
              <input
                maxLength={150}
                onChange={(event) => setTitle(event.target.value)}
                required
                value={title}
              />
              {fieldErrors.title && <span className="field-error">{fieldErrors.title}</span>}
            </label>

            <label>
              Description
              <textarea
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                required
                rows={4}
                value={description}
              />
              {fieldErrors.description && <span className="field-error">{fieldErrors.description}</span>}
            </label>

            <div className="create-project-fields">
              <label>
                Required team size
                <input
                  max={20}
                  min={2}
                  onChange={(event) => setRequiredTeamSize(event.target.value)}
                  required
                  type="number"
                  value={requiredTeamSize}
                />
                {fieldErrors.requiredTeamSize && (
                  <span className="field-error">{fieldErrors.requiredTeamSize}</span>
                )}
              </label>

              <p className="field-hint">This project will be created under your signed-in student account.</p>
            </div>

            <label>
              Required skills
              <select
                disabled={skillsLoading || skills.length === 0}
                multiple
                onChange={updateRequiredSkills}
                value={requiredSkillIds.map(String)}
              >
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>{skill.name}</option>
                ))}
              </select>
              <span className="field-hint">
                {skillsLoading ? 'Loading available skills…' : 'Select up to 20 skills. Use Ctrl or Command to select multiple.'}
              </span>
              {fieldErrors.requiredSkillIds && (
                <span className="field-error">{fieldErrors.requiredSkillIds}</span>
              )}
            </label>
            {!skillsLoading && !skillsError && skills.length === 0 && (
              <p className="field-hint">
                The skill catalog is empty. You can add a skill from your{' '}
                <NavLink to="/skills">Skills page</NavLink>, then return to select it here.
              </p>
            )}

            {skillsError && (
              <div className="error-message" role="alert">
                <p>{skillsError}</p>
                {skillsAuthRequired ? (
                  <BackendSignInForm
                    onPasswordChange={onAuthPasswordChange}
                    onSubmit={onAuthSubmit}
                    onUsernameChange={onAuthUsernameChange}
                    password={authPassword}
                    username={authUsername}
                  />
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => setSkillsRetryKey((key) => key + 1)}
                    type="button"
                  >
                    Retry loading skills
                  </button>
                )}
              </div>
            )}

            {submitError && (
              <div className="error-message" role="alert">
                <p>{submitError}</p>
                {submitAuthRequired && (
                  <BackendSignInForm
                    onPasswordChange={onAuthPasswordChange}
                    onSubmit={onAuthSubmit}
                    onUsernameChange={onAuthUsernameChange}
                    password={authPassword}
                    username={authUsername}
                  />
                )}
              </div>
            )}

            <div className="modal-actions">
              <button className="ghost-button" disabled={submitting} onClick={onClose} type="button">
                Cancel
              </button>
              <button className="primary-button" disabled={submitting || skillsLoading} type="submit">
                {submitting ? (editingProject ? 'Saving…' : 'Creating…') : (editingProject ? 'Save changes' : 'Create project')}
              </button>
            </div>
        </form>
      </section>
    </div>
  )
}

function DashboardPage({
  currentStudent,
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
}) {
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [projects, setProjects] = useState([])
  const [teams, setTeams] = useState([])
  const [incomingRequests, setIncomingRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function loadDashboard() {
      setLoading(true)
      setError('')
      try {
        const [projectData, teamData, requestData] = await Promise.all([
          fetchApiJson('/api/projects', controller.signal, 'dashboard projects', authCredentials),
          fetchApiJson(
            `/api/students/${encodeURIComponent(currentStudent.id)}/teams`,
            controller.signal,
            'dashboard teams',
            authCredentials,
          ),
          fetchApiJson(
            `/api/students/${encodeURIComponent(currentStudent.id)}/team-requests/incoming`,
            controller.signal,
            'dashboard invitations',
            authCredentials,
          ),
        ])
        if (!Array.isArray(projectData) || !Array.isArray(teamData) || !Array.isArray(requestData)) {
          throw new Error('The backend returned invalid dashboard data.')
        }
        setProjects(projectData)
        setTeams(teamData)
        setIncomingRequests(requestData)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') return
        setError(loadError instanceof Error
          ? loadError.message
          : 'Could not load dashboard data.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    loadDashboard()
    return () => controller.abort()
  }, [authCredentials, currentStudent.id, retryKey])

  const openProjects = projects.filter((project) => project.status === 'OPEN')
  const ownedProjects = projects.filter(
    (project) => String(project.ownerStudentId) === String(currentStudent.id),
  )
  const pendingRequests = incomingRequests.filter((request) => request.status === 'PENDING')

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Welcome back, {currentStudent.name}.</h1>
        </div>
        <button className="primary-button" onClick={() => setCreateModalOpen(true)} type="button">
          Create project
        </button>
      </div>

      {createModalOpen && (
        <CreateProjectModal
          currentStudent={currentStudent}
          authCredentials={authCredentials}
          authPassword={authPassword}
          authUsername={authUsername}
          onAuthPasswordChange={onAuthPasswordChange}
          onAuthSubmit={onAuthSubmit}
          onAuthUsernameChange={onAuthUsernameChange}
          onClose={() => setCreateModalOpen(false)}
        />
      )}

      {loading && <p className="projects-message" role="status">Loading your dashboard…</p>}
      {!loading && error && (
        <div className="projects-message error-message dashboard-error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" onClick={() => setRetryKey((key) => key + 1)} type="button">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="summary-grid">
            {[
              ['Open projects', openProjects.length, 'Currently accepting teammates'],
              ['Your projects', ownedProjects.length, 'Projects you created'],
              ['Your teams', teams.length, 'Teams you belong to'],
              ['Pending invites', pendingRequests.length, 'Incoming requests awaiting a response'],
            ].map(([label, value, detail]) => (
              <article className="summary-card" key={label}>
                <span className="summary-label">{label}</span>
                <strong className="summary-value">{value}</strong>
                <small>{detail}</small>
              </article>
            ))}
          </div>

          <section className="content-panel">
            <div className="section-header">
              <h2>Available projects</h2>
              <NavLink className="text-button" to="/projects">View all projects</NavLink>
            </div>
            {openProjects.length === 0 ? (
              <div className="projects-prompt">
                <p>There are no open projects right now. Create one or check back later.</p>
                <button className="secondary-button" onClick={() => setCreateModalOpen(true)} type="button">
                  Create a project
                </button>
              </div>
            ) : (
              <div className="project-list">
                {openProjects.slice(0, 3).map((project) => (
                  <article className="project-card" key={project.id}>
                    <div className="project-headline">
                      <div>
                        <h3>{project.title}</h3>
                        <span className="project-status">{project.status}</span>
                      </div>
                      <span className="project-members">Team size: {project.requiredTeamSize}</span>
                    </div>
                    <p>{project.description || 'No description provided.'}</p>
                    <div className="tag-row">
                      {(project.requiredSkills ?? []).map((skill) => (
                        <span className="tag" key={skill.id}>{skill.name}</span>
                      ))}
                      {(!project.requiredSkills || project.requiredSkills.length === 0) && (
                        <span className="project-no-skills">No required skills listed</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function ProfilePage({
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
  studentId,
}) {
  const [requestedStudentId] = useState(studentId)
  const [student, setStudent] = useState(null)
  const [form, setForm] = useState({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [authRequired, setAuthRequired] = useState(false)
  const [success, setSuccess] = useState('')
  const [interests, setInterests] = useState([])
  const [interestDraft, setInterestDraft] = useState('')
  const [interestsLoading, setInterestsLoading] = useState(false)
  const [interestsSaving, setInterestsSaving] = useState(false)
  const [interestsError, setInterestsError] = useState('')
  const [interestsAuthRequired, setInterestsAuthRequired] = useState(false)
  const [interestsSuccess, setInterestsSuccess] = useState('')
  const [interestsRetryKey, setInterestsRetryKey] = useState(0)

  useEffect(() => {
    if (!requestedStudentId) {
      return undefined
    }

    const controller = new AbortController()
    async function loadProfile() {
      setLoading(true)
      setError('')
      setAuthRequired(false)
      setSuccess('')
      try {
        const data = await fetchApiJson(
          `/api/students/${encodeURIComponent(requestedStudentId)}`,
          controller.signal,
          'student profile',
          authCredentials,
        )
        setStudent(data)
        setForm({
          name: data.name ?? '',
          rollNumber: data.rollNumber ?? '',
          email: data.email ?? '',
          department: data.department ?? '',
          academicYear: data.academicYear ?? '',
          available: Boolean(data.available),
        })
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setAuthRequired(loadError instanceof ApiError && loadError.status === 401 && !authCredentials)
        setError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading the profile.')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    loadProfile()
    return () => controller.abort()
  }, [authCredentials, requestedStudentId])

  useEffect(() => {
    if (!requestedStudentId) {
      return undefined
    }

    const controller = new AbortController()
    async function loadInterests() {
      setInterestsLoading(true)
      setInterestsError('')
      setInterestsAuthRequired(false)
      try {
        const data = await fetchApiJson(
          `/api/students/${encodeURIComponent(requestedStudentId)}/interests`,
          controller.signal,
          'student interests',
          authCredentials,
        )
        if (
          data === null ||
          typeof data !== 'object' ||
          data.studentId !== Number(requestedStudentId) ||
          !Array.isArray(data.interests)
        ) {
          throw new Error('The backend returned an invalid student interests response.')
        }
        setInterests(data.interests)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setInterestsAuthRequired(loadError instanceof ApiError && loadError.status === 401 && !authCredentials)
        setInterestsError(
          loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading interests.',
        )
      } finally {
        if (!controller.signal.aborted) {
          setInterestsLoading(false)
        }
      }
    }

    loadInterests()
    return () => controller.abort()
  }, [authCredentials, interestsRetryKey, requestedStudentId])

  async function handleSave(event) {
    event.preventDefault()
    if (!student) {
      return
    }

    setSaving(true)
    setError('')
    setAuthRequired(false)
    setSuccess('')
    try {
      const updatedStudent = await fetchApiMutation(
        `/api/students/${encodeURIComponent(student.id)}`,
        'student profile update',
        authCredentials,
        {
          method: 'PUT',
          body: {
            ...form,
            academicYear: Number(form.academicYear),
          },
        },
      )
      setStudent(updatedStudent)
      setSuccess('Profile changes saved.')
    } catch (saveError) {
      setAuthRequired(saveError instanceof ApiError && saveError.status === 401 && !authCredentials)
      setError(saveError instanceof Error ? saveError.message : 'An unexpected error occurred while saving the profile.')
    } finally {
      setSaving(false)
    }
  }

  async function saveInterests(nextInterests) {
    setInterestsSaving(true)
    setInterestsError('')
    setInterestsAuthRequired(false)
    setInterestsSuccess('')
    try {
      const data = await fetchApiMutation(
        `/api/students/${encodeURIComponent(requestedStudentId)}/interests`,
        'student interests update',
        authCredentials,
        {
          method: 'PUT',
          body: { interests: nextInterests },
        },
      )
      if (
        data === null ||
        typeof data !== 'object' ||
        data.studentId !== Number(requestedStudentId) ||
        !Array.isArray(data.interests)
      ) {
        throw new Error('The backend returned an invalid student interests response.')
      }
      setInterests(data.interests)
      setInterestDraft('')
      setInterestsSuccess('Interests saved.')
    } catch (saveError) {
      setInterestsAuthRequired(saveError instanceof ApiError && saveError.status === 401 && !authCredentials)
      setInterestsError(
        saveError instanceof Error ? saveError.message : 'An unexpected error occurred while saving interests.',
      )
    } finally {
      setInterestsSaving(false)
    }
  }

  function handleAddInterest(event) {
    event.preventDefault()
    const interest = interestDraft.trim()
    if (!interest) {
      setInterestsError('Enter an interest before adding it.')
      return
    }
    if (interest.length > 100) {
      setInterestsError('Interests must be 100 characters or fewer.')
      return
    }
    if (interests.some((currentInterest) => currentInterest.toLowerCase() === interest.toLowerCase())) {
      setInterestsError('That interest is already in your profile.')
      return
    }
    if (interests.length >= 20) {
      setInterestsError('You can save up to 20 interests.')
      return
    }
    saveInterests([...interests, interest])
  }

  function handleRemoveInterest(interestToRemove) {
    saveInterests(interests.filter((interest) => interest !== interestToRemove))
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">My profile</p>
          <h1>{student?.name ?? 'Student profile'}</h1>
        </div>
      </div>

      <section className="content-panel">
        {loading && <p className="projects-message" role="status">Loading profile…</p>}
        <p className="field-hint">
          Your profile and interests are loaded from your authenticated student account.
        </p>
        {error && (
          <div className="error-message" role="alert">
            <p>{error}</p>
            {authRequired && (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            )}
          </div>
        )}
        {success && <p className="success-message" role="status">{success}</p>}
        {student && (
          <form className="profile-form" onSubmit={handleSave}>
            <div className="profile-fields">
              <label>
                Name
                <input
                  maxLength={100}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  required
                  value={form.name}
                />
              </label>
              <label>
                Roll number
                <input
                  aria-describedby="profile-roll-number-hint"
                  maxLength={50}
                  readOnly
                  value={form.rollNumber}
                />
                <span className="field-hint" id="profile-roll-number-hint">
                  This student identifier cannot be changed from your profile.
                </span>
              </label>
              <label>
                Email
                <input
                  maxLength={254}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  required
                  type="email"
                  value={form.email}
                />
              </label>
              <label>
                Department
                <input
                  maxLength={100}
                  onChange={(event) => setForm({ ...form, department: event.target.value })}
                  required
                  value={form.department}
                />
              </label>
              <label>
                Academic year
                <input
                  max={8}
                  min={1}
                  onChange={(event) => setForm({ ...form, academicYear: event.target.value })}
                  required
                  type="number"
                  value={form.academicYear}
                />
              </label>
              <label className="availability-field">
                <input
                  checked={form.available}
                  onChange={(event) => setForm({ ...form, available: event.target.checked })}
                  type="checkbox"
                />
                Available for project matching
              </label>
            </div>
            {authRequired && (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            )}
            <button className="primary-button" disabled={saving} type="submit">
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </form>
        )}
        {!student && loading && <p className="projects-message" role="status">Loading student profile…</p>}
      </section>

      <section className="content-panel">
        <div className="section-header compact">
          <h2>Interests</h2>
        </div>
        {!student && <p className="projects-message">Load your student profile to view and manage saved interests.</p>}
        {student && (
          <>
            <p className="field-hint">Interests are stored separately from your technical skills.</p>
            {interestsLoading && <p className="projects-message" role="status">Loading interests…</p>}
            {interestsError && (
              <div className="error-message" role="alert">
                <p>{interestsError}</p>
                {interestsAuthRequired ? (
                  <BackendSignInForm
                    onPasswordChange={onAuthPasswordChange}
                    onSubmit={onAuthSubmit}
                    onUsernameChange={onAuthUsernameChange}
                    password={authPassword}
                    username={authUsername}
                  />
                ) : (
                  <button
                    className="secondary-button"
                    disabled={interestsLoading}
                    onClick={() => setInterestsRetryKey((key) => key + 1)}
                    type="button"
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
            {interestsSuccess && <p className="success-message" role="status">{interestsSuccess}</p>}
            {!interestsLoading && !interestsError && interests.length === 0 && (
              <p className="projects-message">No interests saved yet.</p>
            )}
            {interests.length > 0 && (
              <ul className="interest-list" aria-label="Saved interests">
                {interests.map((interest) => (
                  <li key={interest}>
                    <span>{interest}</span>
                    <button
                      aria-label={`Remove ${interest}`}
                      className="interest-remove"
                      disabled={interestsSaving}
                      onClick={() => handleRemoveInterest(interest)}
                      type="button"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!interestsError && (
              <form className="interest-form" onSubmit={handleAddInterest}>
                <label>
                  Add an interest
                  <input
                    maxLength={100}
                    onChange={(event) => setInterestDraft(event.target.value)}
                    value={interestDraft}
                  />
                </label>
                <button className="primary-button" disabled={interestsSaving || interestsLoading} type="submit">
                  {interestsSaving ? 'Saving…' : 'Add interest'}
                </button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function SkillsPage({
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
  studentId,
}) {
  const [assignedSkills, setAssignedSkills] = useState([])
  const [requestedStudentId] = useState(studentId)
  const [skillName, setSkillName] = useState('')
  const [proficiencyLevel, setProficiencyLevel] = useState('BEGINNER')
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)
  const [error, setError] = useState('')
  const [assignmentError, setAssignmentError] = useState('')
  const [authRequired, setAuthRequired] = useState(false)
  const [success, setSuccess] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    async function loadSkills() {
      setLoading(true)
      setError('')
      setAuthRequired(false)
      try {
        if (requestedStudentId) {
          const studentSkills = await fetchApiJson(
            `/api/students/${encodeURIComponent(requestedStudentId)}/skills`,
            controller.signal,
            'student skills',
            authCredentials,
          )
          if (!Array.isArray(studentSkills)) {
            throw new Error('The backend returned an invalid student skills response: expected a list.')
          }
          setAssignedSkills(studentSkills)
        } else {
          setAssignedSkills([])
        }
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setAuthRequired(loadError instanceof ApiError && loadError.status === 401 && !authCredentials)
        setError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading skills.')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    loadSkills()
    return () => controller.abort()
  }, [authCredentials, refreshKey, requestedStudentId])

  async function handleAssign(event) {
    event.preventDefault()
    const normalizedSkillName = skillName.trim()
    if (!requestedStudentId || normalizedSkillName.length === 0) {
      setAssignmentError('Enter a skill name before adding it.')
      setSuccess('')
      return
    }
    if (assignedSkills.some((skill) => skill.skillName.toLowerCase() === normalizedSkillName.toLowerCase())) {
      setAssignmentError('This skill is already on your profile.')
      setSuccess('')
      return
    }

    setAssigning(true)
    setAssignmentError('')
    setAuthRequired(false)
    setSuccess('')
    try {
      await fetchApiMutation(
        `/api/students/${encodeURIComponent(requestedStudentId)}/skills/by-name`,
        'skill assignment',
        authCredentials,
        {
          method: 'POST',
          body: {
            skillName: normalizedSkillName,
            proficiencyLevel,
          },
        },
      )
      setSuccess('Skill added to the student profile.')
      setSkillName('')
      setRefreshKey((key) => key + 1)
    } catch (assignError) {
      setAuthRequired(assignError instanceof ApiError && assignError.status === 401 && !authCredentials)
      setAssignmentError(assignError instanceof Error ? assignError.message : 'An unexpected error occurred while adding the skill.')
    } finally {
      setAssigning(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Skills</p>
          <h1>Strengths and focus areas</h1>
        </div>
      </div>

      <section className="content-panel">
        {loading && <p className="projects-message" role="status">Loading skills…</p>}
        <p className="field-hint">
          Skills are loaded and managed for your signed-in account.
        </p>
        {loading && <p className="projects-message" role="status">Loading your skills…</p>}
        {error && (
          <div className="error-message" role="alert">
            <p>{error}</p>
            {authRequired && (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            )}
            {!authRequired && (
              <button className="secondary-button" onClick={() => setRefreshKey((key) => key + 1)} type="button">
                Try again
              </button>
            )}
          </div>
        )}
        {success && <p className="success-message" role="status">{success}</p>}

        {requestedStudentId && !loading && !error && (
          <>
            <form className="skill-assignment-form" onSubmit={handleAssign}>
              <label>
                Skill name
                <input
                  autoComplete="off"
                  maxLength={100}
                  onChange={(event) => {
                    setSkillName(event.target.value)
                    setAssignmentError('')
                    setSuccess('')
                  }}
                  placeholder="e.g. JavaScript"
                  required
                  value={skillName}
                />
              </label>
              <label>
                Proficiency
                <select
                  onChange={(event) => setProficiencyLevel(event.target.value)}
                  value={proficiencyLevel}
                >
                  <option value="BEGINNER">Beginner</option>
                  <option value="INTERMEDIATE">Intermediate</option>
                  <option value="ADVANCED">Advanced</option>
                </select>
              </label>
              <button className="primary-button" disabled={assigning || skillName.trim().length === 0} type="submit">
                {assigning ? 'Adding…' : 'Add skill'}
              </button>
            </form>
            {assignmentError && (
              <div className="error-message" role="alert">
                <p>{assignmentError}</p>
                {authRequired && (
                  <BackendSignInForm
                    onPasswordChange={onAuthPasswordChange}
                    onSubmit={onAuthSubmit}
                    onUsernameChange={onAuthUsernameChange}
                    password={authPassword}
                    username={authUsername}
                  />
                )}
              </div>
            )}

            <div className="section-header skill-section-title">
              <h2>Student skills</h2>
            </div>
            {assignedSkills.length === 0 ? (
              <p className="projects-message">No skills have been assigned to this student.</p>
            ) : (
              <div className="skill-list">
                {assignedSkills.map((skill) => (
                  <article className="skill-card" key={skill.skillId}>
                    <div className="skill-head">
                      <h3>{skill.skillName}</h3>
                      <span>{skill.proficiencyLevel ?? 'Not specified'}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function ProjectsPage({
  currentStudent,
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
  selectedProjectId,
  onSelectedProjectId,
}) {
  const location = useLocation()
  const createdProject = location.state?.createdProject
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState(null)
  const [projectFilter, setProjectFilter] = useState('ALL')
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [authRequired, setAuthRequired] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [detailRetryKey, setDetailRetryKey] = useState(0)
  const [selectedProject, setSelectedProject] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailAuthRequired, setDetailAuthRequired] = useState(false)
  const [joinSubmitting, setJoinSubmitting] = useState(false)
  const [joinSubmitted, setJoinSubmitted] = useState(false)
  const [joinMessage, setJoinMessage] = useState('')
  const [joinError, setJoinError] = useState('')
  const [closeSubmitting, setCloseSubmitting] = useState(false)
  const [closeSuccess, setCloseSuccess] = useState('')
  const [closeError, setCloseError] = useState('')

  useEffect(() => {
    if (createdProject && selectedProjectId === null) {
      onSelectedProjectId(createdProject.id)
    }
  }, [createdProject, onSelectedProjectId, selectedProjectId])

  useEffect(() => {
    const controller = new AbortController()

    async function loadProjects() {
      setLoading(true)
      setError('')
      setAuthRequired(false)

      try {
        const data = await fetchApiJson('/api/projects', controller.signal, 'projects', authCredentials)
        if (!Array.isArray(data)) {
          throw new Error('The backend returned an invalid projects response: expected a list.')
        }
        if (
          createdProject &&
          !data.some((project) => String(project.id) === String(createdProject.id))
        ) {
          setProjects([...data, createdProject])
        } else {
          setProjects(data)
        }
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setAuthRequired(loadError instanceof ApiError && loadError.status === 401 && !authCredentials)
        setError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading projects.')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    loadProjects()
    return () => controller.abort()
  }, [refreshKey, authCredentials, createdProject])

  useEffect(() => {
    if (selectedProjectId === null) {
      return undefined
    }

    const controller = new AbortController()

    async function loadProjectDetails() {
      setDetailLoading(true)
      setDetailError('')
      setDetailAuthRequired(false)
      setSelectedProject(null)

      try {
        const data = await fetchApiJson(
          `/api/projects/${encodeURIComponent(selectedProjectId)}`,
          controller.signal,
          'project details',
          authCredentials,
        )
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('The backend returned an invalid project details response.')
        }
        setSelectedProject(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setDetailAuthRequired(
          loadError instanceof ApiError && loadError.status === 401 && !authCredentials,
        )
        setDetailError(
          loadError instanceof Error
            ? loadError.message
            : 'An unexpected error occurred while loading project details.',
        )
      } finally {
        if (!controller.signal.aborted) {
          setDetailLoading(false)
        }
      }
    }

    loadProjectDetails()
    return () => controller.abort()
  }, [selectedProjectId, detailRetryKey, authCredentials])

  async function requestToJoinProject() {
    if (!selectedProject) return
    setJoinSubmitting(true)
    setJoinMessage('')
    setJoinError('')
    try {
      await fetchApiMutation(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/team-requests`,
        'team request',
        authCredentials,
        {
          method: 'POST',
          body: { recipientStudentId: selectedProject.ownerStudentId },
        },
      )
      setJoinSubmitted(true)
      setJoinMessage(`Your request to join ${selectedProject.title} was sent to the project owner.`)
    } catch (requestError) {
      setJoinError(requestError instanceof Error
        ? requestError.message
        : 'An unexpected error occurred while requesting to join this project.')
    } finally {
      setJoinSubmitting(false)
    }
  }

  async function closeSelectedProject() {
    if (!selectedProject || String(selectedProject.ownerStudentId) !== String(currentStudent.id)
        || selectedProject.status !== 'OPEN' || closeSubmitting) {
      return
    }
    if (!window.confirm(`Cancel "${selectedProject.title}"? Existing members and requests will be preserved.`)) {
      return
    }

    setCloseSubmitting(true)
    setCloseSuccess('')
    setCloseError('')
    try {
      const closedProject = await fetchApiMutation(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/close`,
        'project closure',
        authCredentials,
        { method: 'PATCH' },
      )
      if (
        closedProject === null
        || typeof closedProject !== 'object'
        || String(closedProject.id) !== String(selectedProject.id)
        || closedProject.status !== 'CANCELLED'
      ) {
        throw new Error('The backend returned an invalid project closure response.')
      }
      setSelectedProject(closedProject)
      setProjects((currentProjects) => currentProjects.map((project) => (
        String(project.id) === String(closedProject.id) ? closedProject : project
      )))
      setCloseSuccess('Project cancelled. Existing members, requests, and invitations were preserved.')
      setRefreshKey((key) => key + 1)
    } catch (closeRequestError) {
      setCloseError(closeRequestError instanceof Error
        ? closeRequestError.message
        : 'Could not cancel the project. Retry the action.')
    } finally {
      setCloseSubmitting(false)
    }
  }

  const visibleProjects = projects.filter((project) => {
    if (projectFilter === 'OPEN') return project.status === 'OPEN'
    if (projectFilter === 'MINE') {
      return String(project.ownerStudentId) === String(currentStudent.id)
    }
    return true
  })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Projects</p>
          <h1>Current and upcoming team work</h1>
        </div>
        <button className="primary-button" onClick={() => setCreateModalOpen(true)} type="button">
          Create project
        </button>
      </div>

      {(createModalOpen || editingProject) && (
        <CreateProjectModal
          currentStudent={currentStudent}
          authCredentials={authCredentials}
          authPassword={authPassword}
          authUsername={authUsername}
          onAuthPasswordChange={onAuthPasswordChange}
          onAuthSubmit={onAuthSubmit}
          onAuthUsernameChange={onAuthUsernameChange}
          editingProject={editingProject}
          onSaved={(project) => {
            setSelectedProject(project)
            setRefreshKey((key) => key + 1)
            setDetailRetryKey((key) => key + 1)
          }}
          onClose={() => {
            setCreateModalOpen(false)
            setEditingProject(null)
          }}
        />
      )}

      <section className="content-panel">
        <div className="project-filters" role="group" aria-label="Filter projects">
          {[
            ['ALL', 'All projects'],
            ['OPEN', 'Open projects'],
            ['MINE', 'My projects'],
          ].map(([filter, label]) => (
            <button
              aria-pressed={projectFilter === filter}
              className={projectFilter === filter ? 'secondary-button active-filter' : 'text-button'}
              key={filter}
              onClick={() => setProjectFilter(filter)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        {createdProject && (
          <p className="project-created-message" role="status">
            <strong>{createdProject.title}</strong> was created successfully.
          </p>
        )}
        {loading && <p className="projects-message" role="status">Loading projects…</p>}

        {!loading && error && (
          <div className="projects-message error-message" role="alert">
            <p>{error}</p>
            {authRequired && (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            )}
            {!authRequired && (
              <button className="secondary-button" onClick={() => setRefreshKey((key) => key + 1)} type="button">
                Try again
              </button>
            )}
          </div>
        )}

        {!loading && !error && visibleProjects.length === 0 && (
          <div className="projects-prompt">
            <p>
              {projects.length === 0
                ? 'There are no projects to show yet.'
                : 'No projects match this filter.'}
            </p>
            {projectFilter === 'MINE' && (
              <button className="secondary-button" onClick={() => setCreateModalOpen(true)} type="button">
                Create a project
              </button>
            )}
          </div>
        )}

        {!loading && !error && visibleProjects.length > 0 && (
          <div className="project-list">
            {visibleProjects.map((project) => (
              <article className="project-card" key={project.id}>
                <div className="project-headline">
                  <div>
                    <h3>{project.title}</h3>
                    <span className="project-status">{project.status}</span>
                  </div>
                  <span className="project-members">
                    Team size: {project.requiredTeamSize}
                  </span>
                </div>
                <p>{project.description || 'No description provided.'}</p>
                <p className="field-hint">
                  {String(project.ownerStudentId) === String(currentStudent.id)
                    ? 'Created by you'
                  : `Project owner · ${project.ownerName || `Student ${project.ownerStudentId}`}`}
                </p>
                <div className="tag-row">
                  {(project.requiredSkills ?? []).map((skill) => (
                    <span className="tag" key={skill.id}>{skill.name}</span>
                  ))}
                  {(!project.requiredSkills || project.requiredSkills.length === 0) && (
                    <span className="project-no-skills">No required skills listed</span>
                  )}
                </div>
                <button
                  className="text-button project-detail-button"
                  onClick={() => {
                    setJoinSubmitted(false)
                    setJoinMessage('')
                    setJoinError('')
                    setCloseSuccess('')
                    setCloseError('')
                    onSelectedProjectId(project.id)
                  }}
                  type="button"
                >
                  View details
                </button>
              </article>
            ))}
          </div>
        )}

        {selectedProjectId !== null && (
          <section className="project-detail" aria-live="polite">
            <div className="section-header">
              <h2>Project details</h2>
              <button
                className="text-button"
                onClick={() => {
                  onSelectedProjectId(null)
                  setSelectedProject(null)
                  setDetailError('')
                  setDetailAuthRequired(false)
                }}
                type="button"
              >
                Close
              </button>
            </div>
            {detailLoading && <p className="projects-message" role="status">Loading project details…</p>}
            {!detailLoading && detailError && (
              <div className="projects-message error-message" role="alert">
                <p>{detailError}</p>
                {detailAuthRequired && (
                  <BackendSignInForm
                    onPasswordChange={onAuthPasswordChange}
                    onSubmit={onAuthSubmit}
                    onUsernameChange={onAuthUsernameChange}
                    password={authPassword}
                    username={authUsername}
                  />
                )}
                {!detailAuthRequired && (
                  <button
                    className="secondary-button"
                    onClick={() => setDetailRetryKey((key) => key + 1)}
                    type="button"
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
            {!detailLoading && selectedProject && (
              <article>
                <h3>{selectedProject.title}</h3>
                <p>{selectedProject.description || 'No description provided.'}</p>
                <p><strong>Status:</strong> {selectedProject.status}</p>
                <p><strong>Required team size:</strong> {selectedProject.requiredTeamSize}</p>
                <p><strong>Project leader:</strong> {selectedProject.teamLeaderName || selectedProject.ownerName}</p>
                {selectedProject.teamName && <p><strong>Team:</strong> {selectedProject.teamName}</p>}
                <p><strong>Current members:</strong></p>
                {selectedProject.teamMembers?.length > 0 ? (
                  <div className="tag-row">
                    {selectedProject.teamMembers.map((member) => (
                      <span className="tag" key={member.studentId}>
                        {member.name} · {member.role}
                      </span>
                    ))}
                  </div>
                ) : <p className="project-no-skills">No active team members yet.</p>}
                <div className="tag-row">
                  {(selectedProject.requiredSkills ?? []).map((skill) => (
                    <span className="tag" key={skill.id}>{skill.name}</span>
                  ))}
                  {(!selectedProject.requiredSkills || selectedProject.requiredSkills.length === 0) && (
                    <span className="project-no-skills">No required skills listed</span>
                  )}
                </div>
                {String(selectedProject.ownerStudentId) === String(currentStudent.id) ? (
                  <div className="project-actions">
                    <button
                      className="secondary-button"
                      onClick={() => setEditingProject(selectedProject)}
                      type="button"
                    >
                      Edit project
                    </button>
                    {selectedProject.status === 'OPEN' && (
                      <button
                        className="secondary-button"
                        disabled={closeSubmitting}
                        onClick={closeSelectedProject}
                        type="button"
                      >
                        {closeSubmitting ? 'Cancelling project…' : 'Close project'}
                      </button>
                    )}
                  </div>
                ) : (
                  ['OPEN', 'IN_PROGRESS'].includes(selectedProject.status) && (
                    <button
                      className="primary-button"
                      disabled={joinSubmitting || joinSubmitted}
                      onClick={requestToJoinProject}
                      type="button"
                    >
                      {joinSubmitting ? 'Sending request…' : (joinSubmitted ? 'Request sent' : 'Request to join this team')}
                    </button>
                  )
                )}
                {joinMessage && <p className="success-message" role="status">{joinMessage}</p>}
                {joinError && <p className="error-message" role="alert">{joinError}</p>}
                {closeSuccess && <p className="success-message" role="status">{closeSuccess}</p>}
                {closeError && <p className="error-message" role="alert">{closeError}</p>}
              </article>
            )}
          </section>
        )}
      </section>
    </div>
  )
}

function FindTeammatesPage({
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
  studentId,
  selectedProjectId,
  onSelectedProjectId,
}) {
  const [projects, setProjects] = useState([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState('')
  const [projectsAuthRequired, setProjectsAuthRequired] = useState(false)
  const [projectRetryKey, setProjectRetryKey] = useState(0)
  const [studentSkillsResult, setStudentSkillsResult] = useState(null)
  const [studentSkillsRetryKey, setStudentSkillsRetryKey] = useState(0)
  const [recommendations, setRecommendations] = useState([])
  const [recommendationsLoading, setRecommendationsLoading] = useState(false)
  const [recommendationsError, setRecommendationsError] = useState('')
  const [recommendationsAuthRequired, setRecommendationsAuthRequired] = useState(false)
  const [recommendationsRetryKey, setRecommendationsRetryKey] = useState(0)
  const [incomingRequests, setIncomingRequests] = useState([])
  const [outgoingRequests, setOutgoingRequests] = useState([])
  const [incomingHistory, setIncomingHistory] = useState([])
  const [outgoingHistory, setOutgoingHistory] = useState([])
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [requestsError, setRequestsError] = useState('')
  const [requestsAuthRequired, setRequestsAuthRequired] = useState(false)
  const [requestsRetryKey, setRequestsRetryKey] = useState(0)
  const [requestActionError, setRequestActionError] = useState('')
  const [requestActionAuthRequired, setRequestActionAuthRequired] = useState(false)
  const [requestSuccess, setRequestSuccess] = useState('')
  const [sendingStudentId, setSendingStudentId] = useState(null)
  const [respondingRequestId, setRespondingRequestId] = useState(null)
  const studentSkillsResultIsCurrent = studentSkillsResult?.studentId === studentId &&
    studentSkillsResult?.retryKey === studentSkillsRetryKey &&
    studentSkillsResult?.authCredentials === authCredentials
  const studentSkills = studentSkillsResultIsCurrent ? studentSkillsResult.skills : []
  const studentSkillsLoading = Boolean(studentId) && !studentSkillsResultIsCurrent
  const studentSkillsError = studentSkillsResultIsCurrent ? studentSkillsResult.error : ''

  useEffect(() => {
    const controller = new AbortController()

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError('')
      setProjectsAuthRequired(false)
      try {
        const data = await fetchApiJson('/api/projects', controller.signal, 'projects', authCredentials)
        if (!Array.isArray(data)) {
          throw new Error('The backend returned an invalid projects response: expected a list.')
        }
        setProjects(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setProjectsAuthRequired(loadError instanceof ApiError && loadError.status === 401 && !authCredentials)
        setProjectsError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading projects.')
      } finally {
        if (!controller.signal.aborted) {
          setProjectsLoading(false)
        }
      }
    }

    loadProjects()
    return () => controller.abort()
  }, [authCredentials, projectRetryKey])

  useEffect(() => {
    if (!studentId) {
      return undefined
    }
    const controller = new AbortController()
    const retryKey = studentSkillsRetryKey

    async function loadStudentSkills() {
      try {
        const data = await fetchApiJson(
          `/api/students/${encodeURIComponent(studentId)}/skills`,
          controller.signal,
          'your skills',
          authCredentials,
        )
        if (!Array.isArray(data) || data.some((skill) =>
          !skill || !Number.isInteger(Number(skill.skillId)),
        )) {
          throw new Error('The backend returned invalid student skill data.')
        }
        setStudentSkillsResult({
          studentId,
          retryKey,
          authCredentials,
          skills: data,
          error: '',
        })
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') return
        setStudentSkillsResult({
          studentId,
          retryKey,
          authCredentials,
          skills: [],
          error: loadError instanceof Error
            ? loadError.message
            : 'Could not load your saved skills.',
        })
      }
    }

    loadStudentSkills()
    return () => controller.abort()
  }, [authCredentials, studentId, studentSkillsRetryKey])

  const eligibleProjects = projects.filter(
    (project) => project.status === 'OPEN' || project.status === 'IN_PROGRESS',
  )
  const matchingProject = eligibleProjects.find(
    (project) => String(project.id) === String(selectedProjectId),
  )
  function compatibilityLabel(project) {
    if (studentSkillsLoading) return 'Calculating compatibility…'
    if (studentSkillsError) return 'Not enough skill data'
    return getProjectCompatibilityLabel(project, studentSkills)
  }

  useEffect(() => {
    if (!studentId || !matchingProject) {
      return undefined
    }

    const controller = new AbortController()

    async function loadRecommendations() {
      setRecommendationsLoading(true)
      setRecommendations([])
      setRecommendationsError('')
      setRecommendationsAuthRequired(false)
      try {
        const data = await fetchApiJson(
          `/api/projects/${encodeURIComponent(matchingProject.id)}/recommendations`,
          controller.signal,
          'teammate recommendations',
          authCredentials,
        )
        if (!Array.isArray(data)) {
          throw new Error('The backend returned an invalid recommendations response: expected a list.')
        }
        setRecommendations(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setRecommendationsAuthRequired(
          loadError instanceof ApiError && loadError.status === 401 && !authCredentials,
        )
        setRecommendationsError(
          loadError instanceof Error
            ? loadError.message
            : 'An unexpected error occurred while loading teammate recommendations.',
        )
      } finally {
        if (!controller.signal.aborted) {
          setRecommendationsLoading(false)
        }
      }
    }

    loadRecommendations()
    return () => controller.abort()
  }, [authCredentials, matchingProject, recommendationsRetryKey, studentId])

  useEffect(() => {
    const parsedStudentId = Number(studentId)
    if (!Number.isInteger(parsedStudentId) || parsedStudentId <= 0) {
      return undefined
    }

    const controller = new AbortController()

    async function loadRequests() {
      setRequestsLoading(true)
      setRequestsError('')
      setRequestsAuthRequired(false)
      try {
        const [
          incoming,
          outgoing,
          receivedHistory,
          sentHistory,
        ] = await Promise.all([
          fetchApiJson(
            `/api/students/${encodeURIComponent(parsedStudentId)}/team-requests/incoming`,
            controller.signal,
            'incoming team requests',
            authCredentials,
          ),
          fetchApiJson(
            `/api/students/${encodeURIComponent(parsedStudentId)}/team-requests/outgoing`,
            controller.signal,
            'outgoing team requests',
            authCredentials,
          ),
          fetchApiJson(
            `/api/students/${encodeURIComponent(parsedStudentId)}/team-requests/incoming/history`,
            controller.signal,
            'received team request history',
            authCredentials,
          ),
          fetchApiJson(
            `/api/students/${encodeURIComponent(parsedStudentId)}/team-requests/outgoing/history`,
            controller.signal,
            'sent team request history',
            authCredentials,
          ),
        ])
        if (![incoming, outgoing, receivedHistory, sentHistory].every(Array.isArray)) {
          throw new Error('The backend returned an invalid team requests response: expected lists.')
        }
        setIncomingRequests(incoming)
        setOutgoingRequests(outgoing)
        setIncomingHistory(receivedHistory)
        setOutgoingHistory(sentHistory)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setRequestsAuthRequired(
          loadError instanceof ApiError &&
            (loadError.status === 403 || (loadError.status === 401 && !authCredentials)),
        )
        setRequestsError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading team requests.')
      } finally {
        if (!controller.signal.aborted) {
          setRequestsLoading(false)
        }
      }
    }

    loadRequests()
    return () => controller.abort()
  }, [authCredentials, requestsRetryKey, studentId])
  const hasValidStudentId = Number.isInteger(Number(studentId)) && Number(studentId) > 0

  async function handleSendRequest(recipientStudentId) {
    setSendingStudentId(recipientStudentId)
    setRequestActionError('')
    setRequestActionAuthRequired(false)
    setRequestSuccess('')
    try {
      await fetchApiMutation(
        `/api/projects/${encodeURIComponent(matchingProject.id)}/team-requests`,
        'team request',
        authCredentials,
        {
          method: 'POST',
          body: {
            recipientStudentId,
          },
        },
      )
      setRequestSuccess('Team request sent.')
      setRequestsRetryKey((key) => key + 1)
    } catch (sendError) {
      setRequestActionAuthRequired(
        sendError instanceof ApiError &&
          (sendError.status === 403 || (sendError.status === 401 && !authCredentials)),
      )
      setRequestActionError(sendError instanceof Error ? sendError.message : 'An unexpected error occurred while sending the request.')
    } finally {
      setSendingStudentId(null)
    }
  }

  async function handleRequestResponse(requestId, status) {
    setRespondingRequestId(requestId)
    setRequestActionError('')
    setRequestActionAuthRequired(false)
    setRequestSuccess('')
    try {
      await fetchApiMutation(
        `/api/students/${encodeURIComponent(studentId)}/team-requests/${encodeURIComponent(requestId)}/response`,
        'team request response',
        authCredentials,
        {
          method: 'PATCH',
          body: { status },
        },
      )
      setRequestSuccess(status === 'ACCEPTED' ? 'Team request accepted.' : 'Team request rejected.')
      setRequestsRetryKey((key) => key + 1)
    } catch (responseError) {
      setRequestActionAuthRequired(
        responseError instanceof ApiError &&
          (responseError.status === 403 || (responseError.status === 401 && !authCredentials)),
      )
      setRequestActionError(responseError instanceof Error ? responseError.message : 'An unexpected error occurred while responding to the request.')
    } finally {
      setRespondingRequestId(null)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Find teammates</p>
          <h1>Recommended students</h1>
        </div>
      </div>

      <section className="content-panel">
        <div className="recommendation-filters">
          <label>
            Project
            <select
              disabled={!studentId || projectsLoading || Boolean(projectsError)}
              onChange={(event) => {
                onSelectedProjectId(event.target.value || null)
                setRecommendations([])
                setRecommendationsError('')
                setRecommendationsAuthRequired(false)
                setRecommendationsLoading(false)
              }}
              value={matchingProject ? selectedProjectId : ''}
            >
              <option value="">Select a shared eligible project</option>
              {eligibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title} — {compatibilityLabel(project)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-hint">
          Choose an open project to see skill-based recommendations. Only its owner can invite recommended students;
          you can request to join another student's project from the Projects page.
        </p>

        {studentSkillsLoading && (
          <p className="projects-message" role="status">Loading your saved skills to calculate project compatibility…</p>
        )}
        {!studentSkillsLoading && studentSkillsError && (
          <div className="error-message" role="alert">
            <p>{studentSkillsError}</p>
            <button
              className="secondary-button"
              onClick={() => setStudentSkillsRetryKey((key) => key + 1)}
              type="button"
            >
              Retry loading skills
            </button>
          </div>
        )}
        {!studentSkillsLoading && !studentSkillsError && studentSkills.length === 0 && (
          <p className="field-hint">
            Add skills to your profile to calculate project compatibility scores.
          </p>
        )}
        {!studentSkillsLoading && !studentSkillsError && studentSkills.length > 0 && eligibleProjects.some(
          (project) => (project.requiredSkills ?? []).length === 0,
        ) && (
          <p className="field-hint">
            Projects without required skills show “Not enough skill data.”
          </p>
        )}

        {projectsLoading && <p className="projects-message" role="status">Loading projects…</p>}
        {!projectsLoading && projectsError && (
          <div className="error-message" role="alert">
            <p>{projectsError}</p>
            {projectsAuthRequired ? (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            ) : (
              <button className="secondary-button" onClick={() => setProjectRetryKey((key) => key + 1)} type="button">
                Try again
              </button>
            )}
          </div>
        )}
        {!projectsLoading && !projectsError && eligibleProjects.length === 0 && (
          <div className="projects-prompt">
            <p>There are no open projects to recommend teammates for yet.</p>
            <NavLink className="secondary-button" to="/projects">Go to projects</NavLink>
          </div>
        )}
        {matchingProject && matchingProject.requiredSkills?.length === 0 && (
          <p className="field-hint">
            This project has no required skills. The matching service assigns a 100% score when no skills are required.
          </p>
        )}
        {matchingProject && (matchingProject.requiredSkills?.length ?? 0) > 0 && (
          <p className="field-hint">
            Compatibility is the percentage of this project’s required skills that the student has.
          </p>
        )}
        {recommendationsLoading && (
          <p className="projects-message" role="status">Finding recommended teammates…</p>
        )}
        {!recommendationsLoading && recommendationsError && (
          <div className="error-message" role="alert">
            <p>{recommendationsError}</p>
            {recommendationsAuthRequired ? (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            ) : (
              <button
                className="secondary-button"
                onClick={() => setRecommendationsRetryKey((key) => key + 1)}
                type="button"
              >
                Try again
              </button>
            )}
          </div>
        )}
        {!recommendationsLoading && !recommendationsError && matchingProject && recommendations.length === 0 && (
          <p className="projects-message">No available students match this project yet.</p>
        )}
        {!recommendationsLoading && !recommendationsError && matchingProject && recommendations.length > 0 && (
          <div className="teammate-list">
            {recommendations.map((teammate) => (
              <article className="teammate-card" key={teammate.studentId}>
                <div className="teammate-topline">
                  <div className="mini-avatar">{teammate.name?.charAt(0) ?? '?'}</div>
                  <div>
                    <h3>{teammate.name}</h3>
                    <p>{teammate.department} · Year {teammate.academicYear}</p>
                  </div>
                </div>
                <p className="teammate-email">{teammate.email}</p>
                <p className="teammate-student-id">Student ID: {teammate.studentId}</p>
                {matchingProject &&
                  String(matchingProject.ownerStudentId) === String(studentId) && (
                  <button
                    className="primary-button teammate-request-button"
                    disabled={
                      sendingStudentId !== null ||
                      outgoingRequests.some((request) =>
                        String(request.projectId) === String(matchingProject.id) &&
                        String(request.recipientStudentId) === String(teammate.studentId) &&
                        (request.status === 'PENDING' || request.status === 'ACCEPTED'))
                    }
                    onClick={() => handleSendRequest(teammate.studentId)}
                    type="button"
                  >
                    {sendingStudentId === teammate.studentId
                      ? 'Sending…'
                      : outgoingRequests.some((request) =>
                        String(request.projectId) === String(matchingProject.id) &&
                        String(request.recipientStudentId) === String(teammate.studentId) &&
                        (request.status === 'PENDING' || request.status === 'ACCEPTED'))
                        ? 'Request sent'
                        : 'Send team request'}
                  </button>
                )}
                <div className="match-row">
                  <span>Compatibility</span>
                  <strong>{Number(teammate.compatibilityScore).toFixed(1)}%</strong>
                </div>
                <div className="recommendation-skills">
                  <h4>Matching skills</h4>
                  {teammate.matchedSkills.length > 0 ? (
                    <div className="tag-row">
                      {teammate.matchedSkills.map((skill) => <span className="tag" key={skill}>{skill}</span>)}
                    </div>
                  ) : <p className="projects-message">No required skills matched.</p>}
                  {teammate.missingSkills.length > 0 && (
                    <>
                      <h4>Skills still needed</h4>
                      <div className="tag-row">
                        {teammate.missingSkills.map((skill) => <span className="tag missing-skill-tag" key={skill}>{skill}</span>)}
                      </div>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="content-panel">
        <div className="section-header">
          <h2>Team requests</h2>
        </div>
        {!hasValidStudentId && <p className="projects-message">Sign in with a student account to view team requests.</p>}
        {hasValidStudentId && requestsLoading && <p className="projects-message" role="status">Loading team requests…</p>}
        {hasValidStudentId && !requestsLoading && requestsError && (
          <div className="error-message" role="alert">
            <p>{requestsError}</p>
            {requestsAuthRequired ? (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            ) : (
              <button className="secondary-button" onClick={() => setRequestsRetryKey((key) => key + 1)} type="button">
                Try again
              </button>
            )}
          </div>
        )}
        {requestSuccess && <p className="success-message" role="status">{requestSuccess}</p>}
        {requestActionError && (
          <div className="error-message" role="alert">
            <p>{requestActionError}</p>
            {requestActionAuthRequired && (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            )}
          </div>
        )}
        {!requestsLoading && !requestsError && hasValidStudentId &&
          incomingRequests.length === 0 && outgoingRequests.length === 0 &&
          incomingHistory.length === 0 && outgoingHistory.length === 0 && (
            <p className="projects-message">No incoming or outgoing team requests.</p>
          )}
        {!requestsLoading && !requestsError && hasValidStudentId &&
          (incomingRequests.length > 0 || outgoingRequests.length > 0 ||
            incomingHistory.length > 0 || outgoingHistory.length > 0) && (
          <div className="request-columns">
            <div>
              <h3>Incoming · Pending</h3>
              {incomingRequests.length === 0 ? (
                <p className="projects-message">No pending incoming requests.</p>
              ) : (
                <div className="request-list">
                  {incomingRequests.map((request) => (
                    <article className="request-card" key={request.id}>
                      <div>
                        <h4>{request.projectTitle}</h4>
                        <p>{request.teamName} · {request.requestType === 'INVITATION' ? 'Invitation' : 'Join request'}</p>
                        <p>From {request.requestingStudentName} · Student {request.requestingStudentId}</p>
                        <p>Received {new Date(request.createdAt).toLocaleDateString()}</p>
                        <span className={`request-status status-${request.status.toLowerCase()}`}>{request.status}</span>
                      </div>
                      {request.status === 'PENDING' && (
                        <div className="request-actions">
                          <button
                            className="primary-button"
                            disabled={respondingRequestId !== null}
                            onClick={() => handleRequestResponse(request.id, 'ACCEPTED')}
                            type="button"
                          >
                            {respondingRequestId === request.id ? 'Saving…' : 'Accept'}
                          </button>
                          <button
                            className="secondary-button"
                            disabled={respondingRequestId !== null}
                            onClick={() => handleRequestResponse(request.id, 'REJECTED')}
                            type="button"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3>Outgoing · Pending</h3>
              {outgoingRequests.length === 0 ? (
                <p className="projects-message">No pending outgoing requests.</p>
              ) : (
                <div className="request-list">
                  {outgoingRequests.map((request) => (
                    <article className="request-card" key={request.id}>
                      <div>
                        <h4>{request.projectTitle}</h4>
                        <p>{request.teamName} · {request.requestType === 'INVITATION' ? 'Invitation sent' : 'Join request sent'}</p>
                        <p>To {request.recipientStudentName} · Student {request.recipientStudentId}</p>
                        <p>Sent {new Date(request.createdAt).toLocaleDateString()}</p>
                        <span className={`request-status status-${request.status.toLowerCase()}`}>{request.status}</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {!requestsLoading && !requestsError && hasValidStudentId &&
          (incomingHistory.length > 0 || outgoingHistory.length > 0) && (
            <section className="request-history">
              <h3>Request history</h3>
              <div className="request-columns">
                {[
                  ['Received', incomingHistory],
                  ['Sent', outgoingHistory],
                ].map(([direction, requests]) => (
                  <div key={direction}>
                    <h4>{direction}</h4>
                    {requests.length === 0 ? (
                      <p className="projects-message">No answered {direction.toLowerCase()} requests.</p>
                    ) : (
                      <div className="request-list">
                        {requests.map((request) => (
                          <article className="request-card" key={request.id}>
                            <div>
                              <h4>{request.projectTitle}</h4>
                              <p>{request.teamName} · {request.requestType === 'INVITATION' ? 'Invitation' : 'Join request'}</p>
                              <p>
                                {direction === 'Received' ? 'From' : 'To'}{' '}
                                {direction === 'Received'
                                  ? request.requestingStudentName
                                  : request.recipientStudentName}
                              </p>
                              <p>
                                {request.status === 'ACCEPTED'
                                  ? 'Accepted'
                                  : request.status === 'REJECTED' ? 'Rejected' : 'Withdrawn'} ·{' '}
                                {new Date(request.updatedAt).toLocaleDateString()}
                              </p>
                              <span className={`request-status status-${request.status.toLowerCase()}`}>
                                {request.status}
                              </span>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
      </section>
    </div>
  )
}

function TeamDashboardPage({
  authCredentials,
  authUsername,
  authPassword,
  onAuthSubmit,
  onAuthUsernameChange,
  onAuthPasswordChange,
  onSelectedProjectId,
  studentId,
}) {
  const navigate = useNavigate()
  const requestedStudentId = studentId
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [authRequired, setAuthRequired] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!requestedStudentId) {
      return undefined
    }

    const parsedStudentId = Number(requestedStudentId)
    if (!Number.isInteger(parsedStudentId) || parsedStudentId <= 0) {
      return undefined
    }

    const controller = new AbortController()

    async function loadTeams() {
      setLoading(true)
      setError('')
      setAuthRequired(false)
      try {
        const data = await fetchApiJson(
          `/api/students/${encodeURIComponent(parsedStudentId)}/teams`,
          controller.signal,
          'student teams',
          authCredentials,
        )
        if (!Array.isArray(data)) {
          throw new Error('The backend returned an invalid teams response: expected a list.')
        }
        setTeams(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return
        }
        setAuthRequired(
          loadError instanceof ApiError &&
            (loadError.status === 403 || (loadError.status === 401 && !authCredentials)),
        )
        setError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred while loading teams.')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    loadTeams()
    return () => controller.abort()
  }, [authCredentials, requestedStudentId, retryKey])

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Team dashboard</p>
          <h1>Your project teams</h1>
        </div>
      </div>

      <section className="content-panel">
        <p className="field-hint">
          Team information is loaded for your authenticated student account.
        </p>
        {loading && <p className="projects-message" role="status">Loading teams and members…</p>}
        {!loading && error && (
          <div className="error-message" role="alert">
            <p>{error}</p>
            {authRequired ? (
              <BackendSignInForm
                onPasswordChange={onAuthPasswordChange}
                onSubmit={onAuthSubmit}
                onUsernameChange={onAuthUsernameChange}
                password={authPassword}
                username={authUsername}
              />
            ) : (
              <button className="secondary-button" onClick={() => setRetryKey((key) => key + 1)} type="button">
                Try again
              </button>
            )}
          </div>
        )}
        {!loading && !error && requestedStudentId && teams.length === 0 && (
          <p className="projects-message">You are not an active member of any teams yet.</p>
        )}
        {!loading && !error && teams.length > 0 && (
          <div className="team-dashboard-list">
            {teams.map((team) => (
              <article className="team-dashboard-card" key={team.teamId}>
                <div className="team-dashboard-heading">
                  <div>
                    <p className="eyebrow">{team.status} · {team.studentRole}</p>
                    <h2>{team.teamName}</h2>
                  </div>
                  <span className="team-size">
                    {team.members.length} / {team.project.requiredTeamSize} members
                  </span>
                </div>
                <section className="team-project">
                  <div className="section-header compact">
                    <h3>{team.project.title}</h3>
                    <span className="project-status">{team.project.status}</span>
                  </div>
                  <p><strong>Project leader:</strong> {team.project.ownerName || `Student ${team.project.ownerStudentId}`}</p>
                  <p>{team.project.description}</p>
                  <button
                    className="text-button project-detail-button"
                    onClick={() => {
                      onSelectedProjectId(team.project.id)
                      navigate('/projects')
                    }}
                    type="button"
                  >
                    View project details
                  </button>
                </section>
                <section className="team-members">
                  <div className="section-header compact">
                    <h3>Active members</h3>
                  </div>
                  <div className="team-member-list">
                    {team.members.map((member) => (
                      <article className="team-member-card" key={member.studentId}>
                        <div className="mini-avatar">{member.name?.charAt(0) ?? '?'}</div>
                        <div className="team-member-details">
                          <h4>{member.name}</h4>
                          <p>{member.department} · Year {member.academicYear}</p>
                          <p>{member.email}</p>
                        </div>
                        <div className="team-member-badges">
                          <span>{member.role}</span>
                          <span>{member.membershipStatus}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function RequireStudent({ currentStudent, authLoading }) {
  const location = useLocation()
  if (authLoading) {
    return <p className="projects-message" role="status">Checking your student session…</p>
  }
  if (!currentStudent) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  if (currentStudent.accountRole !== 'STUDENT') {
    return <Navigate to="/admin" replace />
  }
  return <Outlet />
}

function RequireAdmin({ currentStudent, authLoading }) {
  const location = useLocation()
  if (authLoading) {
    return <p className="projects-message" role="status">Checking your administrator session…</p>
  }
  if (!currentStudent) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  if (currentStudent.accountRole !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />
  }
  return <Outlet />
}

function LoginPage({ onLogin, currentStudent, adminOnly = false }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const registrationComplete = location.state?.registrationComplete === true

  if (currentStudent) {
    return <Navigate to={currentStudent.accountRole === 'ADMIN' ? '/admin' : '/dashboard'} replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const user = await fetchApiMutation('/api/auth/login', 'sign in', null, {
        method: 'POST',
        body: { email: email.trim(), password },
      })
      if (
        user === null ||
        typeof user !== 'object' ||
        !['STUDENT', 'ADMIN'].includes(user.accountRole) ||
        (user.accountRole === 'STUDENT' && !Number.isInteger(Number(user.id))) ||
        typeof user.name !== 'string'
      ) {
        throw new Error('The backend returned invalid account details.')
      }
      if (adminOnly && user.accountRole !== 'ADMIN') {
        await fetchApiMutation('/api/auth/logout', 'sign out', null, { method: 'POST' })
        setError('This sign-in page is for configured administrator accounts.')
        return
      }
      onLogin(user)
      const destination = location.state?.from?.pathname
        || (user.accountRole === 'ADMIN' ? '/admin' : '/dashboard')
      navigate(destination, { replace: true })
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'An unexpected error occurred while signing in.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page auth-page">
      <section className="content-panel auth-panel">
        <p className="eyebrow">{adminOnly ? 'Administrator access' : 'Welcome back'}</p>
        <h1>{adminOnly ? 'Administrator sign in' : 'Sign in to TeamMatch'}</h1>
        {registrationComplete && (
          <p className="success-message" role="status">Registration complete. Sign in with your new student account.</p>
        )}
        <p className="field-hint">
          {adminOnly
            ? 'Use the configured administrator username and password.'
            : 'Sign in with your registered student account or configured administrator account.'}
        </p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            {adminOnly ? 'Administrator username' : 'Email or administrator username'}
            <input
              autoComplete="username"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="text"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <button className="primary-button" disabled={loading} type="submit">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {adminOnly ? (
          <p className="auth-alternate"><NavLink to="/login">Student sign in</NavLink></p>
        ) : (
          <p className="auth-alternate">New to TeamMatch? <NavLink to="/register">Create a student account</NavLink></p>
        )}
      </section>
    </div>
  )
}

function RegistrationPage({ currentStudent }) {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: '',
    rollNumber: '',
    email: '',
    password: '',
    department: '',
    academicYear: '1',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})

  if (currentStudent) {
    return <Navigate to={currentStudent.accountRole === 'ADMIN' ? '/admin' : '/dashboard'} replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const errors = {}
    if (form.name.trim().length === 0) errors.name = 'Enter your name.'
    if (form.rollNumber.trim().length === 0) errors.rollNumber = 'Enter your roll number.'
    if (form.email.trim().length === 0) errors.email = 'Enter your email.'
    if (form.password.length < 12 || form.password.length > 72) {
      errors.password = 'Use a password between 12 and 72 characters.'
    }
    if (form.department.trim().length === 0) errors.department = 'Enter your department.'
    const academicYear = Number(form.academicYear)
    if (!Number.isInteger(academicYear) || academicYear < 1 || academicYear > 8) {
      errors.academicYear = 'Academic year must be from 1 to 8.'
    }
    setFieldErrors(errors)
    setError('')
    if (Object.keys(errors).length > 0) return

    setLoading(true)
    try {
      const student = await fetchApiMutation('/api/students', 'student registration', null, {
        method: 'POST',
        body: {
          ...form,
          name: form.name.trim(),
          rollNumber: form.rollNumber.trim(),
          email: form.email.trim(),
          department: form.department.trim(),
          academicYear,
        },
      })
      if (
        student === null ||
        typeof student !== 'object' ||
        !Number.isInteger(Number(student.id)) ||
        student.accountRole !== 'STUDENT' ||
        'password' in student ||
        'passwordHash' in student
      ) {
        throw new Error('The backend returned invalid registration details.')
      }
      navigate('/login', {
        replace: true,
        state: { registrationComplete: true },
      })
    } catch (registrationError) {
      setError(
        registrationError instanceof Error
          ? registrationError.message
          : 'An unexpected error occurred while creating your account.',
      )
    } finally {
      setLoading(false)
    }
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
  }

  return (
    <div className="page auth-page">
      <section className="content-panel auth-panel">
        <p className="eyebrow">Student registration</p>
        <h1>Create your account</h1>
        <p className="field-hint">Your password is stored by the backend as a secure hash.</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <form className="auth-form registration-form" onSubmit={handleSubmit}>
          <label>
            Full name
            <input maxLength={100} onChange={(event) => updateField('name', event.target.value)} required value={form.name} />
            {fieldErrors.name && <span className="field-error">{fieldErrors.name}</span>}
          </label>
          <label>
            Roll number
            <input maxLength={50} onChange={(event) => updateField('rollNumber', event.target.value)} required value={form.rollNumber} />
            {fieldErrors.rollNumber && <span className="field-error">{fieldErrors.rollNumber}</span>}
          </label>
          <label>
            Student email
            <input autoComplete="email" maxLength={254} onChange={(event) => updateField('email', event.target.value)} required type="email" value={form.email} />
            {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
          </label>
          <label>
            Password
            <input autoComplete="new-password" maxLength={72} minLength={12} onChange={(event) => updateField('password', event.target.value)} required type="password" value={form.password} />
            {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
          </label>
          <label>
            Department
            <input maxLength={100} onChange={(event) => updateField('department', event.target.value)} required value={form.department} />
            {fieldErrors.department && <span className="field-error">{fieldErrors.department}</span>}
          </label>
          <label>
            Academic year
            <input max={8} min={1} onChange={(event) => updateField('academicYear', event.target.value)} required type="number" value={form.academicYear} />
            {fieldErrors.academicYear && <span className="field-error">{fieldErrors.academicYear}</span>}
          </label>
          <button className="primary-button" disabled={loading} type="submit">
            {loading ? 'Creating account…' : 'Register'}
          </button>
        </form>
        <p className="auth-alternate">
          Already registered? <NavLink to="/login">Sign in</NavLink>
        </p>
      </section>
    </div>
  )
}

function AdminMonitoringPage({ authCredentials }) {
  const [overview, setOverview] = useState(null)
  const [section, setSection] = useState('overview')
  const [pageData, setPageData] = useState(null)
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [requestStatus, setRequestStatus] = useState('')
  const [projectFilterId, setProjectFilterId] = useState('')
  const [inspected, setInspected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function loadOverview() {
      try {
        const data = await fetchApiJson(
          '/api/admin/overview',
          controller.signal,
          'admin overview',
          authCredentials,
        )
        if (!data || typeof data.students !== 'number' || typeof data.requestsByStatus !== 'object') {
          throw new Error('The backend returned invalid admin overview data.')
        }
        setOverview(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') return
        setError(loadError instanceof Error ? loadError.message : 'Could not load admin overview.')
      }
    }
    loadOverview()
    return () => controller.abort()
  }, [authCredentials, retryKey])

  useEffect(() => {
    if (section === 'overview') return undefined
    const controller = new AbortController()
    async function loadPage() {
      setLoading(true)
      setError('')
      const params = new URLSearchParams({ page: String(page), size: '20' })
      if (section === 'students' || section === 'projects') {
        if (query.trim()) params.set('query', query.trim())
      }
      if (section === 'requests') {
        if (requestStatus) params.set('status', requestStatus)
        if (projectFilterId) params.set('projectId', projectFilterId)
      }
      const resource = section === 'requests' ? 'team-requests' : section
      try {
        const data = await fetchApiJson(
          `/api/admin/${resource}?${params.toString()}`,
          controller.signal,
          `admin ${resource}`,
          authCredentials,
        )
        if (!data || !Array.isArray(data.content) || typeof data.totalPages !== 'number') {
          throw new Error('The backend returned invalid paginated admin data.')
        }
        setPageData(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') return
        setError(loadError instanceof Error ? loadError.message : 'Could not load admin records.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    loadPage()
    return () => controller.abort()
  }, [authCredentials, page, projectFilterId, query, requestStatus, retryKey, section])

  useEffect(() => {
    if (!inspected) return undefined
    const controller = new AbortController()
    async function loadDetail() {
      setDetailLoading(true)
      setDetailError('')
      try {
        const data = await fetchApiJson(
          `/api/admin/${inspected.type}/${encodeURIComponent(inspected.id)}`,
          controller.signal,
          `admin ${inspected.type} details`,
          authCredentials,
        )
        setDetail(data)
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') return
        setDetailError(loadError instanceof Error ? loadError.message : 'Could not load record details.')
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false)
      }
    }
    loadDetail()
    return () => controller.abort()
  }, [authCredentials, inspected, retryKey])

  function changeSection(nextSection) {
    setSection(nextSection)
    setPage(0)
    setPageData(null)
    setError('')
    if (nextSection !== 'requests') setProjectFilterId('')
  }

  function inspectRecord(type, id) {
    setDetail(null)
    setDetailError('')
    setInspected({ type, id })
  }

  const rows = pageData?.content ?? []

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Administrator dashboard</h1>
          <p>Read-only platform monitoring and record review.</p>
        </div>
        <button className="secondary-button" onClick={() => setRetryKey((key) => key + 1)} type="button">
          Refresh data
        </button>
      </div>

      {error && (
        <div className="projects-message error-message admin-load-error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" onClick={() => setRetryKey((key) => key + 1)} type="button">
            Retry
          </button>
        </div>
      )}
      <nav className="project-filters admin-tabs" aria-label="Administrator sections">
        {[
          ['overview', 'Overview'],
          ['students', 'Students'],
          ['projects', 'Projects'],
          ['teams', 'Teams'],
          ['requests', 'Requests & invitations'],
        ].map(([value, label]) => (
          <button
            aria-pressed={section === value}
            className={section === value ? 'secondary-button active-filter' : 'text-button'}
            key={value}
            onClick={() => changeSection(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      {section === 'overview' && (
        <section className="content-panel">
          {overview ? (
            <>
              <div className="summary-grid admin-summary-grid">
                {[
                  ['Students', overview.students],
                  ['Projects', overview.projects],
                  ['Teams', overview.teams],
                  ['Requests', overview.requests],
                ].map(([label, count]) => (
                  <article className="summary-card" key={label}><p>{label}</p><strong>{count}</strong></article>
                ))}
              </div>
              <h2>Request status totals</h2>
              <div className="tag-row">
                {Object.entries(overview.requestsByStatus).map(([status, count]) => (
                  <span className="tag" key={status}>{status}: {count}</span>
                ))}
              </div>
            </>
          ) : <p className="projects-message" role="status">Loading platform totals…</p>}
        </section>
      )}

      {(section === 'students' || section === 'projects') && (
        <section className="content-panel">
          <label className="admin-search">
            Search {section}
            <input
              onChange={(event) => { setQuery(event.target.value); setPage(0) }}
              placeholder={section === 'students'
                ? 'Name, roll/email, skill, interest, project, or team'
                : 'Project title, description, owner, skill, or member'}
              value={query}
            />
          </label>
        </section>
      )}
      {section === 'requests' && (
        <section className="content-panel admin-request-filters">
          <label>
            Status
            <select onChange={(event) => { setRequestStatus(event.target.value); setPage(0) }} value={requestStatus}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="REJECTED">Rejected</option>
              <option value="WITHDRAWN">Withdrawn</option>
            </select>
          </label>
          {projectFilterId && (
            <button className="text-button" onClick={() => setProjectFilterId('')} type="button">
              Clear project filter ({projectFilterId})
            </button>
          )}
        </section>
      )}

      {section !== 'overview' && (
        <section className="content-panel admin-section">
          {loading && <p className="projects-message" role="status">Loading records…</p>}
          {!loading && !error && rows.length === 0 && <p className="projects-message">No records found.</p>}
          {!loading && !error && rows.length > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  {section === 'students' && <tr><th>Name</th><th>Roll number</th><th>Email</th><th>Department</th><th>Review</th></tr>}
                  {section === 'projects' && <tr><th>Project</th><th>Owner</th><th>Status</th><th>Capacity</th><th>Review</th></tr>}
                  {section === 'teams' && <tr><th>Team</th><th>Project</th><th>Status</th><th>Members</th></tr>}
                  {section === 'requests' && <tr><th>Type</th><th>Project / team</th><th>From</th><th>To</th><th>Status</th><th>Updated</th></tr>}
                </thead>
                <tbody>
                  {section === 'students' && rows.map((student) => (
                    <tr key={student.id}>
                      <td>{student.name}</td><td>{student.rollNumber}</td><td>{student.email}</td><td>{student.department}</td>
                      <td><button className="text-button" onClick={() => inspectRecord('students', student.id)} type="button">Inspect</button></td>
                    </tr>
                  ))}
                  {section === 'projects' && rows.map((project) => (
                    <tr key={project.id}>
                      <td>{project.title}</td><td>{project.ownerName}</td><td>{project.status}</td><td>{project.requiredTeamSize}</td>
                      <td><button className="text-button" onClick={() => inspectRecord('projects', project.id)} type="button">Inspect</button></td>
                    </tr>
                  ))}
                  {section === 'teams' && rows.map((team) => (
                    <tr key={team.id}>
                      <td>{team.name}</td><td>{team.projectTitle}</td><td>{team.status}</td>
                      <td>{team.members.map((member) => `${member.studentName} · ${member.role} · ${member.status}`).join(', ') || 'No members'}</td>
                    </tr>
                  ))}
                  {section === 'requests' && rows.map((request) => (
                    <tr key={request.id}>
                      <td>{request.requestType === 'INVITATION' ? 'Invitation' : 'Join request'}</td>
                      <td>{request.projectTitle}<br />{request.teamName}</td>
                      <td>{request.requestingStudentName} · {request.requestingStudentId}</td>
                      <td>{request.recipientStudentName} · {request.recipientStudentId}</td>
                      <td><span className={`admin-status status-${request.status.toLowerCase()}`}>{request.status}</span></td>
                      <td>{new Date(request.updatedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pageData && (
            <div className="admin-pagination">
              <span>{pageData.totalElements} total · page {pageData.totalPages === 0 ? 0 : pageData.page + 1} of {pageData.totalPages}</span>
              <button className="secondary-button" disabled={page <= 0} onClick={() => setPage((value) => value - 1)} type="button">Previous</button>
              <button className="secondary-button" disabled={page + 1 >= pageData.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button>
            </div>
          )}
        </section>
      )}

      {inspected && (
        <section className="content-panel admin-section">
          <div className="section-heading">
            <h2>{inspected.type === 'students' ? 'Student record' : 'Project record'}</h2>
            <button className="text-button" onClick={() => { setInspected(null); setDetail(null); setDetailError('') }} type="button">Close</button>
          </div>
          {detailLoading && <p className="projects-message" role="status">Loading details…</p>}
          {detailError && <p className="error-message" role="alert">{detailError}</p>}
          {detail && inspected.type === 'students' && (
            <div>
              <p><strong>{detail.name}</strong> · {detail.rollNumber} · {detail.email}</p>
              <p>{detail.department} · Year {detail.academicYear} · {detail.available ? 'Available' : 'Unavailable'}</p>
              <p><strong>Skills:</strong> {detail.skills.join(', ') || 'None'}</p>
              <p><strong>Interests:</strong> {detail.interests.join(', ') || 'None'}</p>
              <h3>Created projects</h3>
              {detail.projects.map((project) => <p key={project.id}>{project.title} · {project.status}</p>)}
              <h3>Memberships</h3>
              {detail.memberships.map((membership) => (
                <p key={membership.teamId}>{membership.teamName} · {membership.projectTitle} · {membership.role} · {membership.status}</p>
              ))}
            </div>
          )}
          {detail && inspected.type === 'projects' && (
            <div>
              <p><strong>{detail.title}</strong> · {detail.status} · capacity {detail.requiredTeamSize}</p>
              <p>{detail.description}</p>
              <p><strong>Creator / leader:</strong> {detail.ownerName} · student {detail.ownerStudentId}</p>
              <p><strong>Required skills:</strong> {detail.requiredSkills.join(', ') || 'None'}</p>
              <p><strong>Team:</strong> {detail.teamName || 'Not formed'}{detail.teamStatus ? ` · ${detail.teamStatus}` : ''}</p>
              <p><strong>Members:</strong> {detail.members.map((member) => `${member.studentName} · ${member.role} · ${member.status}`).join(', ') || 'None'}</p>
              <button
                className="secondary-button"
                onClick={() => { setProjectFilterId(String(detail.id)); changeSection('requests') }}
                type="button"
              >
                Review related requests
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function LandingPage({ currentStudent }) {
  const destination = currentStudent?.accountRole === 'ADMIN'
    ? '/admin'
    : currentStudent?.accountRole === 'STUDENT'
      ? '/dashboard'
      : null

  return (
    <div className="page landing-page">
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="eyebrow">Build better teams, together</p>
          <h1>Find your people. Make your next project happen.</h1>
          <p className="landing-description">
            TeamMatch helps students discover project opportunities and connect with teammates
            whose skills and interests complement their own.
          </p>
          <div className="landing-actions">
            {destination ? (
              <NavLink className="primary-button landing-button" to={destination}>
                {currentStudent.accountRole === 'ADMIN' ? 'Open admin monitoring' : 'Go to your dashboard'}
              </NavLink>
            ) : (
              <>
                <NavLink className="primary-button landing-button" to="/register">Create a student account</NavLink>
                <NavLink className="secondary-button landing-button" to="/login">Sign in</NavLink>
              </>
            )}
          </div>
          <p className="landing-note">Create a profile, explore projects, and find collaborators.</p>
        </div>
        <div className="landing-art" aria-hidden="true">
          <img src={heroImage} alt="" />
          <div className="landing-art-caption">
            <span className="landing-art-mark">T</span>
            <span>Good work starts with a good team.</span>
          </div>
        </div>
      </section>
      <section className="landing-highlights" aria-labelledby="how-it-works-title">
        <h2 className="landing-steps-title" id="how-it-works-title">How TeamMatch works</h2>
        <article>
          <span className="highlight-number">01</span>
          <h3>Create your profile</h3>
          <p>Set up your student profile so teammates can learn about you.</p>
        </article>
        <article>
          <span className="highlight-number">02</span>
          <h3>Add skills and interests</h3>
          <p>Show the strengths and topics you want to bring to a project.</p>
        </article>
        <article>
          <span className="highlight-number">03</span>
          <h3>Create or discover a project</h3>
          <p>Explore project opportunities or create one for your team.</p>
        </article>
        <article>
          <span className="highlight-number">04</span>
          <h3>Find compatible teammates</h3>
          <p>Review recommendations based on the project's required skills.</p>
        </article>
        <article>
          <span className="highlight-number">05</span>
          <h3>Send and respond to requests</h3>
          <p>Invite recommended students and manage incoming invitations.</p>
        </article>
        <article>
          <span className="highlight-number">06</span>
          <h3>Form and manage your team</h3>
          <p>Track your team, project, and active members from your dashboard.</p>
        </article>
      </section>
    </div>
  )
}

function NotFoundPage() {
  return (
    <div className="page">
      <div className="content-panel not-found">
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <NavLink to="/dashboard">Return to dashboard</NavLink>
      </div>
    </div>
  )
}

function App() {
  const navigate = useNavigate()
  const [authCredentials, setAuthCredentials] = useState(null)
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [studentId, setStudentId] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState(null)
  const [currentStudent, setCurrentStudent] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState('')
  const [sessionRestoreAttempt, setSessionRestoreAttempt] = useState(0)
  const [logoutError, setLogoutError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    if (!mobileNavOpen) return undefined
    function closeOnEscape(event) {
      if (event.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileNavOpen])

  function handleAuthSubmit() {
    setAuthCredentials({ username: authUsername, password: authPassword })
  }

  useEffect(() => {
    function handleUnauthorized() {
      setCurrentStudent(null)
      setStudentId('')
      setSelectedProjectId(null)
      setAuthCredentials(null)
      navigate('/login', { replace: true })
    }

    window.addEventListener('teammatch:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('teammatch:unauthorized', handleUnauthorized)
  }, [navigate])

  useEffect(() => {
    const controller = new AbortController()
    async function restoreSession() {
      try {
        const user = await fetchApiJson('/api/auth/me', controller.signal, 'user session', null, {
          handleUnauthorized: false,
        })
        if (
          !user ||
          !['STUDENT', 'ADMIN'].includes(user.accountRole) ||
          typeof user.name !== 'string' ||
          (user.accountRole === 'STUDENT' && !Number.isInteger(Number(user.id)))
        ) {
          throw new Error('The backend returned invalid session details.')
        }
        setCurrentStudent(user)
        setStudentId(user.accountRole === 'STUDENT' ? String(user.id) : '')
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        if (error instanceof ApiError && error.status === 401) {
          setAuthError('')
          setAuthCredentials(null)
        } else {
          setAuthError(sessionRestoreErrorMessage(error))
        }
        setCurrentStudent(null)
        setStudentId('')
      } finally {
        if (!controller.signal.aborted) setAuthLoading(false)
      }
    }
    restoreSession()
    return () => controller.abort()
  }, [navigate, sessionRestoreAttempt])

  function handleLogin(user) {
    setCurrentStudent(user)
    setStudentId(user.accountRole === 'STUDENT' ? String(user.id) : '')
    setAuthCredentials(null)
    setAuthUsername('')
    setAuthPassword('')
    setAuthError('')
  }

  function retrySessionRestore() {
    setAuthError('')
    setAuthLoading(true)
    setSessionRestoreAttempt((attempt) => attempt + 1)
  }

  async function handleLogout() {
    setLoggingOut(true)
    setLogoutError('')
    try {
      await fetchApiMutation('/api/auth/logout', 'student logout', authCredentials, { method: 'POST' })
      setCurrentStudent(null)
      setStudentId('')
      setSelectedProjectId(null)
      setAuthCredentials(null)
      setAuthUsername('')
      setAuthPassword('')
      navigate('/login', { replace: true })
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'An unexpected error occurred while signing out.')
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className={mobileNavOpen ? 'sidebar nav-open' : 'sidebar'}>
        <div className="brand-block">
          <span className="brand-mark">T</span>
          <div>
            <p className="brand-subtitle">
              {currentStudent?.accountRole === 'ADMIN' ? 'Admin console' : 'Student hub'}
            </p>
            <h2>TeamMatch</h2>
          </div>
        </div>

        <button
          aria-controls="main-navigation"
          aria-expanded={mobileNavOpen}
          className="mobile-nav-toggle secondary-button"
          onClick={() => setMobileNavOpen((isOpen) => !isOpen)}
          type="button"
        >
          {mobileNavOpen ? 'Close menu' : 'Menu'}
        </button>
        <nav
          className="nav-links"
          id="main-navigation"
          aria-label="Main navigation"
          onClick={() => setMobileNavOpen(false)}
        >
          {currentStudent?.accountRole === 'ADMIN' ? (
            <>
              <NavLink className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} to="/">Home</NavLink>
              <NavLink className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} to="/admin">
                Admin Monitoring
              </NavLink>
            </>
          ) : currentStudent?.accountRole === 'STUDENT' ? (
            [
              ['Home', '/'],
              ['Dashboard', '/dashboard'],
              ['My Profile', '/profile'],
              ['Skills', '/skills'],
              ['Projects', '/projects'],
              ['Find Teammates', '/find-teammates'],
              ['Team Dashboard', '/team-dashboard'],
            ].map(([label, to]) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              >
                {label}
              </NavLink>
            ))
          ) : (
            <>
              <NavLink className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} to="/">Home</NavLink>
              <NavLink className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} to="/login">Sign in</NavLink>
              <NavLink className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} to="/register">Register</NavLink>
              <NavLink className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} to="/admin/login">Admin sign in</NavLink>
            </>
          )}
        </nav>

      </aside>

      <main className="main-panel">
        {currentStudent && (
          <header className="topbar">
            <div>
              <p className="eyebrow">{currentStudent.accountRole === 'ADMIN' ? 'Administrator workspace' : 'Student workspace'}</p>
              <h3>Welcome, {currentStudent.name}</h3>
            </div>
            <button className="ghost-button" disabled={loggingOut} onClick={handleLogout} type="button">
              {loggingOut ? 'Signing out…' : 'Log out'}
            </button>
          </header>
        )}
        {logoutError && <p className="error-message" role="alert">{logoutError}</p>}
        {authError && !currentStudent && (
          <section className="auth-error-banner" role="alert" aria-live="assertive">
            <p>{authError}</p>
            <div className="auth-error-actions">
              <button disabled={authLoading} onClick={retrySessionRestore} type="button">
                {authLoading ? 'Retrying…' : 'Retry'}
              </button>
              <button onClick={() => setAuthError('')} type="button">Dismiss</button>
            </div>
          </section>
        )}

        <Routes>
          <Route path="/" element={<LandingPage currentStudent={currentStudent} />} />
          <Route path="/login" element={<LoginPage currentStudent={currentStudent} onLogin={handleLogin} />} />
          <Route path="/admin/login" element={<LoginPage adminOnly currentStudent={currentStudent} onLogin={handleLogin} />} />
          <Route path="/register" element={<RegistrationPage currentStudent={currentStudent} />} />
          <Route element={<RequireAdmin authLoading={authLoading} currentStudent={currentStudent} />}>
            <Route path="/admin" element={<AdminMonitoringPage authCredentials={authCredentials} />} />
          </Route>
          <Route element={<RequireStudent authLoading={authLoading} currentStudent={currentStudent} />}>
            <Route
              path="/dashboard"
              element={(
                <DashboardPage
                  currentStudent={currentStudent}
                  authCredentials={authCredentials}
                  authPassword={authPassword}
                  authUsername={authUsername}
                  onAuthPasswordChange={setAuthPassword}
                  onAuthSubmit={handleAuthSubmit}
                  onAuthUsernameChange={setAuthUsername}
                />
              )}
            />
            <Route
              path="/profile"
              element={(
                <ProfilePage
                  authCredentials={authCredentials}
                  authPassword={authPassword}
                  authUsername={authUsername}
                  onAuthPasswordChange={setAuthPassword}
                  onAuthSubmit={handleAuthSubmit}
                  onAuthUsernameChange={setAuthUsername}
                  studentId={studentId}
                />
              )}
            />
            <Route
              path="/skills"
              element={(
                <SkillsPage
                  authCredentials={authCredentials}
                  authPassword={authPassword}
                  authUsername={authUsername}
                  onAuthPasswordChange={setAuthPassword}
                  onAuthSubmit={handleAuthSubmit}
                  onAuthUsernameChange={setAuthUsername}
                  studentId={studentId}
                />
              )}
            />
            <Route
              path="/projects"
              element={(
                <ProjectsPage
                  currentStudent={currentStudent}
                  authCredentials={authCredentials}
                  authPassword={authPassword}
                  authUsername={authUsername}
                  onAuthPasswordChange={setAuthPassword}
                  onAuthSubmit={handleAuthSubmit}
                  onAuthUsernameChange={setAuthUsername}
                  onSelectedProjectId={setSelectedProjectId}
                  selectedProjectId={selectedProjectId}
                />
              )}
            />
            <Route
              path="/find-teammates"
              element={(
                <FindTeammatesPage
                  authCredentials={authCredentials}
                  authPassword={authPassword}
                  authUsername={authUsername}
                  onAuthPasswordChange={setAuthPassword}
                  onAuthSubmit={handleAuthSubmit}
                  onAuthUsernameChange={setAuthUsername}
                  onSelectedProjectId={setSelectedProjectId}
                  selectedProjectId={selectedProjectId}
                  studentId={studentId}
                />
              )}
            />
            <Route
              path="/team-dashboard"
              element={(
                <TeamDashboardPage
                  authCredentials={authCredentials}
                  authPassword={authPassword}
                  authUsername={authUsername}
                  onAuthPasswordChange={setAuthPassword}
                  onAuthSubmit={handleAuthSubmit}
                  onAuthUsernameChange={setAuthUsername}
                  onSelectedProjectId={setSelectedProjectId}
                  studentId={studentId}
                />
              )}
            />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
