import {
  Job,
  SeniorityLevel,
  WorkplaceType,
  JobWithAnalysis,
  UserProfile,
  GupySearchDiagnostics,
  SolidesSearchDiagnostics,
  PandapeSearchDiagnostics,
} from '../types';
import { calculateJobScore } from './scoring';
import { deduplicateJobs } from '../utils/deduplication';
import { classifyGeo } from './geoClassifier';
import { getStoredJobBoards } from '../data/jobBoards';
import { fetchAllGreenhouseJobs } from './greenhouse';
import { fetchGupyJobs } from './gupy';
import { fetchSolidesJobs } from './solides';
import { fetchPandapeJobs } from './pandape';
import { syncJobToSupabase } from './cloudSync';
import { applySearchLocationFilter, LocationFilterMetrics } from './locationFilter';

export interface SearchOptions {
  query?: string;
  location?: string;
  daysOld?: number;
  country?: string;
  searchAllTargets?: boolean;
  minScoreFilter?: number; // e.g. 0, 65, 75, 85, 90
  includeUncertainIntl?: boolean;
  sourceFilter?: 'all' | 'adzuna' | 'greenhouse' | 'gupy' | 'solides' | 'pandape' | 'remotar' | 'vagasremotas';
}

export interface AdzunaRawItem {
  id: string | number;
  title: string;
  description: string;
  redirect_url: string;
  created: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  contract_type?: string;
  contract_time?: string;
}

export interface AdzunaRouteCheck {
  requestMethod: string;
  requestPath: string;
  backendReached: boolean;
  responseContentType: string;
  backendHttpStatus: number;
  adzunaHttpStatus?: number | null;
}

export interface DiagnosticsDetails {
  runtimeBackend?: string;
  runtimeSearchHandler?: string;
  locationFilterRuntime?: string;
  routeCheck?: AdzunaRouteCheck;
  adzuna?: {
    runtimeBackend?: string;
    clientEndpoint?: string;
    backendHandler?: string;
    credentialsStatus?: { appId: string; appKey: string };
    received: number;
    normalized: number;
    error?: string | null;
    errorStage?: 'REQUEST' | 'BACKEND_PROXY' | 'ADZUNA_API' | 'RESPONSE_PARSE' | 'NORMALIZATION' | null;
    adzunaHttpStatus?: number | null;
    httpStatus?: number;
    routeCheck?: AdzunaRouteCheck;
  };
  greenhouse: {
    boardsChecked: number;
    boardsSuccessful: number;
    boardsFailed: number;
    jobsReceived: number;
    brazilCompatible: number;
    error?: string | null;
  };
  gupy?: GupySearchDiagnostics;
  solides?: SolidesSearchDiagnostics;
  pandape?: PandapeSearchDiagnostics;
  remotar?: {
    jobsReceived: number;
    normalized: number;
    error?: string | null;
  };
  vagasremotas?: {
    reposChecked: number;
    reposSuccessful: number;
    jobsReceived: number;
    normalized: number;
    error?: string | null;
  };
  locationFilter: LocationFilterMetrics;
  global: {
    beforeLocationFilter: number;
    beforeDeduplication: number;
    duplicatesRemoved: number;
    finalCount: number;
    latencyMs: number;
  };
}

export interface AdzunaDiagnostics extends DiagnosticsDetails {
  runtimeBackend?: string;
  runtimeSearchHandler?: string;
  locationFilterRuntime?: string;
  clientEndpoint?: string;
  backendHandler?: string;
  credentialsStatus?: { appId: string; appKey: string };
  statusCategory: string;
  httpStatus: number;
  adzunaHttpStatus?: number | null;
  errorStage?: 'REQUEST' | 'BACKEND_PROXY' | 'ADZUNA_API' | 'RESPONSE_PARSE' | 'NORMALIZATION' | null;
  statusText?: string;
  countryCode: string;
  query: string;
  location: string;
  daysOld: number;
  apiUrlSanitized: string;
  adzunaCount: number;
  resultsReceived: number;
  normalizedCount: number;
  duplicatesRemoved: number;
  finalCount: number;
  latencyMs: number;
  adzunaError?: string | null;
}

export interface SearchJobsResult {
  ok: boolean;
  jobs: JobWithAnalysis[];
  error?: string;
  errorCode?: string;
  errorStage?: 'REQUEST' | 'BACKEND_PROXY' | 'ADZUNA_API' | 'RESPONSE_PARSE' | 'NORMALIZATION' | null;
  diagnostics: AdzunaDiagnostics;
}

/**
 * Calculates friendly relative age label from publication date string.
 */
export function getFriendlyAgeLabel(publishedAt: string): string {
  if (!publishedAt) return 'Data recente';
  try {
    const pubDate = new Date(publishedAt);
    if (isNaN(pubDate.getTime())) return 'Data recente';
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - pubDate.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Hoje';
    if (diffDays === 1) return '1 dia atrás';
    return `${diffDays} dias atrás`;
  } catch {
    return 'Data recente';
  }
}

/**
 * Clean HTML tags from a string.
 */
function cleanText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Infer WorkplaceType from job title, description, and location
 */
function inferWorkplaceType(title: string, description: string, location?: string): WorkplaceType {
  const locLower = (location || '').toLowerCase();
  const titleLower = (title || '').toLowerCase();
  const descLower = (description || '').toLowerCase();

  if (
    locLower.includes('híbrido') ||
    locLower.includes('hibrido') ||
    locLower.includes('hybrid') ||
    titleLower.includes('híbrido') ||
    titleLower.includes('hibrido') ||
    titleLower.includes('hybrid') ||
    descLower.includes('modelo híbrido') ||
    descLower.includes('modelo hibrido') ||
    descLower.includes('trabalho híbrido') ||
    descLower.includes('trabalho hibrido') ||
    descLower.includes('regime híbrido') ||
    descLower.includes('regime hibrido')
  ) {
    return 'Híbrido';
  }

  if (
    locLower.includes('remoto') ||
    locLower.includes('remote') ||
    locLower.includes('home office') ||
    locLower.includes('teletrabalho') ||
    titleLower.includes('remoto') ||
    titleLower.includes('remote') ||
    titleLower.includes('home office') ||
    descLower.includes('100% remoto') ||
    descLower.includes('100% remote') ||
    descLower.includes('totalmente remoto') ||
    descLower.includes('vaga remota') ||
    descLower.includes('trabalho remoto') ||
    descLower.includes('regime remoto')
  ) {
    return 'Remoto';
  }

  return 'Presencial';
}

/**
 * Infer SeniorityLevel from job title and description
 */
function inferSeniority(title: string, description: string): SeniorityLevel {
  const combined = `${title} ${description}`.toLowerCase();
  if (combined.includes('estágio') || combined.includes('estagio') || combined.includes('intern')) {
    return 'Estágio';
  }
  if (combined.includes('junior') || combined.includes('júnior') || combined.includes('jr')) {
    return 'Júnior';
  }
  if (
    combined.includes('lead') ||
    combined.includes('lider') ||
    combined.includes('líder') ||
    combined.includes('gerente') ||
    combined.includes('head') ||
    combined.includes('coordenador') ||
    combined.includes('manager')
  ) {
    return 'Liderança';
  }
  if (
    combined.includes('especialista') ||
    combined.includes('specialist') ||
    combined.includes('principal') ||
    combined.includes('architect')
  ) {
    return 'Especialista';
  }
  if (combined.includes('senior') || combined.includes('sênior') || combined.includes('sr')) {
    return 'Sênior';
  }
  return 'Pleno';
}

/**
 * Extract key requirements from title and description
 */
function extractRequirements(title: string, description: string): string[] {
  const commonTech = [
    'Customer Success', 'CSM', 'Onboarding', 'SaaS', 'SQL', 'Power BI', 'Excel',
    'Churn', 'NPS', 'HubSpot', 'Salesforce', 'Zendesk', 'Gainsight', 'CRM',
    'Python', 'React', 'Node.js', 'PostgreSQL', 'API', 'Análise de Dados',
    'Inglês Fluente', 'Espanhol', 'Gestão de Contas', 'Retenção'
  ];

  const reqs = new Set<string>();
  const combined = `${title} ${description}`.toLowerCase();

  for (const tech of commonTech) {
    if (combined.includes(tech.toLowerCase())) {
      reqs.add(tech);
    }
  }

  if (reqs.size === 0) {
    reqs.add('Customer Success / Atendimento B2B');
    reqs.add('Análise de Métricas & Retenção');
  }

  return Array.from(reqs).slice(0, 8);
}

/**
 * Formats salary range from Adzuna min/max numbers
 */
function formatSalary(min?: number, max?: number): string | undefined {
  if (!min && !max) return undefined;
  if (min && max) {
    return `R$ ${Math.round(min).toLocaleString('pt-BR')} - R$ ${Math.round(max).toLocaleString('pt-BR')}`;
  }
  if (min) return `A partir de R$ ${Math.round(min).toLocaleString('pt-BR')}`;
  if (max) return `Até R$ ${Math.round(max).toLocaleString('pt-BR')}`;
  return undefined;
}

/**
 * Normalizes a raw Adzuna item into the internal Job model.
 */
export function normalizeAdzunaJob(item: AdzunaRawItem): Job {
  const title = cleanText(item.title || 'Vaga Sem Título');
  const description = cleanText(item.description || 'Descrição não fornecida.');
  const company = cleanText(item.company?.display_name || 'Empresa Confidencial');
  const location = cleanText(item.location?.display_name || 'Brasil');

  return {
    id: `adzuna-${item.id}`,
    title,
    company,
    location,
    workplaceType: inferWorkplaceType(title, description, location),
    seniority: inferSeniority(title, description),
    description,
    requirements: extractRequirements(title, description),
    url: item.redirect_url || '#',
    publishedAt: item.created ? item.created.split('T')[0] : new Date().toISOString().split('T')[0],
    salaryRange: formatSalary(item.salary_min, item.salary_max),
    source: 'adzuna',
    sources: ['adzuna'],
    geoCategory: classifyGeo(location, description),
  };
}

/**
 * Executes search request against Adzuna endpoint.
 */
export async function fetchAdzunaRaw(
  query: string,
  location: string,
  daysOld: number,
  country: string = 'br'
): Promise<{
  ok: boolean;
  results?: AdzunaRawItem[];
  data?: any;
  error?: string;
  errorStage?: 'REQUEST' | 'BACKEND_PROXY' | 'ADZUNA_API' | 'RESPONSE_PARSE' | 'NORMALIZATION' | null;
  routeCheck?: AdzunaRouteCheck;
}> {
  const requestMethod = 'POST';
  const requestPath = '/api/adzuna/search';

  try {
    const res = await fetch(requestPath, {
      method: requestMethod,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        location,
        daysOld,
        country: country || 'br',
      }),
    });

    const contentType = res.headers.get('content-type') || 'application/json';

    let rawText = '';
    try {
      rawText = await res.text();
    } catch (readErr: any) {
      const routeCheck: AdzunaRouteCheck = {
        requestMethod,
        requestPath,
        backendReached: true,
        responseContentType: contentType,
        backendHttpStatus: res.status,
        adzunaHttpStatus: null,
      };
      return {
        ok: false,
        errorStage: 'REQUEST',
        routeCheck,
        error: `Falha ao ler resposta do backend (${res.status}): ${readErr.message || 'Stream error'}`,
        data: {
          ok: false,
          httpStatus: res.status,
          statusCategory: 'STREAM_ERROR',
          errorStage: 'REQUEST',
          countryCode: country,
          query,
          location,
          daysOld,
          adzunaError: `Falha na leitura da resposta (HTTP ${res.status})`,
        },
      };
    }

    let data: any = null;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr: any) {
      const sanitizedSnippet = rawText.substring(0, 120).replace(/<[^>]*>?/gm, '').trim();
      const routeCheck: AdzunaRouteCheck = {
        requestMethod,
        requestPath,
        backendReached: true,
        responseContentType: contentType,
        backendHttpStatus: res.status,
        adzunaHttpStatus: null,
      };
      return {
        ok: false,
        errorStage: 'RESPONSE_PARSE',
        routeCheck,
        error: `Backend retornou resposta não-JSON (HTTP ${res.status}): ${sanitizedSnippet || 'Erro de formato'}`,
        data: {
          ok: false,
          httpStatus: res.status,
          statusCategory: 'INVALID_JSON_RESPONSE',
          errorStage: 'RESPONSE_PARSE',
          countryCode: country,
          query,
          location,
          daysOld,
          adzunaError: `Backend retornou conteúdo não-JSON (HTTP ${res.status})`,
        },
      };
    }

    const routeCheck: AdzunaRouteCheck = {
      requestMethod,
      requestPath,
      backendReached: true,
      responseContentType: contentType,
      backendHttpStatus: data?.httpStatus || res.status,
      adzunaHttpStatus: data?.adzunaHttpStatus ?? (data?.ok ? 200 : null),
    };

    if (!data.ok) {
      return {
        ok: false,
        errorStage: data.errorStage || (data.statusCategory === 'MISSING_CREDENTIALS' ? 'BACKEND_PROXY' : 'ADZUNA_API'),
        data,
        routeCheck,
        error: data.adzunaError || data.message || `Erro na API (${data.statusCategory || data.httpStatus})`,
      };
    }

    return { ok: true, results: data.results || [], data, routeCheck };
  } catch (err: any) {
    const routeCheck: AdzunaRouteCheck = {
      requestMethod,
      requestPath,
      backendReached: false,
      responseContentType: 'none (network error)',
      backendHttpStatus: 0,
      adzunaHttpStatus: null,
    };
    return {
      ok: false,
      errorStage: 'REQUEST',
      routeCheck,
      error: `Não foi possível conectar ao servidor backend: ${err.message || 'Erro de rede'}`,
      data: {
        ok: false,
        httpStatus: 0,
        statusCategory: 'NETWORK_ERROR',
        errorStage: 'REQUEST',
        countryCode: country,
        query,
        location,
        daysOld,
        adzunaError: `Falha ao conectar com o servidor local: ${err.message || 'Erro de rede'}`,
      },
    };
  }
}

/**
 * Fetch raw job items from Remotar (remotar.com.br)
 */
export async function fetchRemotarRaw(
  query: string,
  daysOld: number
): Promise<{ ok: boolean; results: Job[]; error?: string }> {
  try {
    const res = await fetch('/api/remotar/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, daysOld, limit: 60 }),
    });
    if (!res.ok) {
      return { ok: false, results: [], error: `Remotar proxy falhou (HTTP ${res.status})` };
    }
    const data = await res.json();
    return { ok: Boolean(data.ok), results: data.results || [], error: data.error };
  } catch (err: any) {
    return { ok: false, results: [], error: err.message || 'Erro ao consultar Remotar' };
  }
}

/**
 * Fetch raw job items from Vagas Remotas (vagasremotas.com.br / GitHub BR Remote Jobs)
 */
export async function fetchVagasRemotasRaw(
  query: string,
  daysOld: number
): Promise<{
  ok: boolean;
  results: Job[];
  reposChecked: number;
  reposSuccessful: number;
  error?: string;
}> {
  try {
    const res = await fetch('/api/vagasremotas/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, daysOld, limit: 60 }),
    });
    if (!res.ok) {
      return {
        ok: false,
        results: [],
        reposChecked: 0,
        reposSuccessful: 0,
        error: `Vagas Remotas proxy falhou (HTTP ${res.status})`,
      };
    }
    const data = await res.json();
    return {
      ok: Boolean(data.ok),
      results: data.results || [],
      reposChecked: data.reposChecked || 0,
      reposSuccessful: data.reposSuccessful || 0,
      error: data.error,
    };
  } catch (err: any) {
    return {
      ok: false,
      results: [],
      reposChecked: 0,
      reposSuccessful: 0,
      error: err.message || 'Erro ao consultar Vagas Remotas',
    };
  }
}

/**
 * Primary function to search jobs and run scoring pipeline across Adzuna + Greenhouse.
 */
export async function searchRealJobs(
  options: SearchOptions,
  userProfile: UserProfile
): Promise<SearchJobsResult> {
  const startTime = performance.now();

  const daysOld = options.daysOld || 30;
  const location = options.location || '';
  const country = (options.country || 'br').toLowerCase().trim();
  const sourceFilter = options.sourceFilter || 'all';

  let adzunaRawItems: AdzunaRawItem[] = [];
  let adzunaApiError: string | undefined;
  let adzunaErrorStage: 'REQUEST' | 'BACKEND_PROXY' | 'ADZUNA_API' | 'RESPONSE_PARSE' | 'NORMALIZATION' | null = null;
  let backendData: any = null;
  let adzunaRouteCheck: AdzunaRouteCheck | undefined = undefined;

  // 1. Fetch Adzuna Jobs (if sourceFilter is 'all' or 'adzuna')
  if (sourceFilter === 'all' || sourceFilter === 'adzuna') {
    if (options.searchAllTargets && userProfile.targetTitles && userProfile.targetTitles.length > 0) {
      const targetQueries = userProfile.targetTitles.slice(0, 3);
      const fetchPromises = targetQueries.map((q) => fetchAdzunaRaw(q, location, daysOld, country));

      const results = await Promise.all(fetchPromises);

      for (const res of results) {
        if (res.data) backendData = res.data;
        if (res.routeCheck) adzunaRouteCheck = res.routeCheck;
        if (res.ok && res.results) {
          adzunaRawItems.push(...res.results);
        } else if (!adzunaApiError && res.error) {
          adzunaApiError = res.error;
          adzunaErrorStage = res.errorStage || null;
        }
      }
    } else {
      const query = options.query || 'Customer Success';
      const res = await fetchAdzunaRaw(query, location, daysOld, country);
      if (res.data) backendData = res.data;
      if (res.routeCheck) adzunaRouteCheck = res.routeCheck;
      if (res.ok && res.results) {
        adzunaRawItems = res.results;
      } else {
        adzunaApiError = res.error;
        adzunaErrorStage = res.errorStage || null;
      }
    }
  }

  const normalizedAdzunaJobs: Job[] = adzunaRawItems.map(normalizeAdzunaJob);

  // 2. Fetch Greenhouse Jobs (if sourceFilter is 'all' or 'greenhouse')
  let ghJobsRaw: Job[] = [];
  let ghBoardsChecked = 0;
  let ghBoardsSuccessful = 0;
  let ghBoardsFailed = 0;
  let ghError: string | null = null;

  if (sourceFilter === 'all' || sourceFilter === 'greenhouse') {
    try {
      const storedBoards = getStoredJobBoards();
      const ghResult = await fetchAllGreenhouseJobs(storedBoards);
      ghBoardsChecked = ghResult.boardsChecked;
      ghBoardsSuccessful = ghResult.boardsSuccessful;
      ghBoardsFailed = ghResult.boardsFailed;
      ghJobsRaw = ghResult.jobs;
    } catch (err: any) {
      ghError = err.message || 'Erro ao consultar Greenhouse';
    }
  }

  // Filter Greenhouse jobs by recency (daysOld)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const recentGhJobs = ghJobsRaw.filter((job) => {
    if (!job.publishedAt) return true;
    try {
      const pubDate = new Date(job.publishedAt);
      if (isNaN(pubDate.getTime())) return true;
      return pubDate >= cutoffDate;
    } catch {
      return true;
    }
  });

  // Filter Greenhouse jobs by user target titles/keywords if query provided
  const queryTerms = (options.query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const targetTitlesLower = (userProfile.targetTitles || []).map((t) => t.toLowerCase());

  const relevantGhJobs = recentGhJobs.filter((job) => {
    // If no specific query/targets, keep all
    if (queryTerms.length === 0 && targetTitlesLower.length === 0) return true;

    const titleLower = job.title.toLowerCase();
    const descLower = job.description.toLowerCase();

    // Check query match
    if (queryTerms.length > 0) {
      const matchesQuery = queryTerms.some((term) => titleLower.includes(term) || descLower.includes(term));
      if (matchesQuery) return true;
    }

    // Check target title match
    const matchesTarget = targetTitlesLower.some((target) => {
      const targetWords = target.split(/\s+/).filter((w) => w.length > 2);
      return targetWords.some((w) => titleLower.includes(w));
    });

    return matchesTarget;
  });

  // 3. Fetch Gupy Jobs (portal.gupy.io) if sourceFilter is 'all' or 'gupy'
  let gupyJobs: Job[] = [];
  let gupyDiagnostics: GupySearchDiagnostics = {
    status: 'ACTIVE',
    publicDiscovery: 'AVAILABLE',
    blockedCount: 0,
    duplicatesRemoved: 0,
    finalGupyResults: 0,
    durationMs: 0,
    cacheStatus: 'LIVE',
    adapterVersion: 'GUPY-BRAZIL-V1',
    expansionStage: 'BRAZIL-SOURCES-V1',
    error: null,
  };
  let gupyError: string | null = null;
  if (sourceFilter === 'all' || sourceFilter === 'gupy') {
    try {
      const queryToUse = options.query || (userProfile.targetTitles?.[0] || '');
      const gupyRes = await fetchGupyJobs({ query: queryToUse, location, daysOld });
      gupyDiagnostics = gupyRes.diagnostics;
      if (gupyRes.ok) {
        gupyJobs = gupyRes.jobs;
      } else {
        gupyError = gupyRes.error || null;
      }
    } catch (err: any) {
      gupyError = err.message || 'Erro ao conectar com Gupy';
      gupyDiagnostics.status = 'ERROR';
      gupyDiagnostics.error = gupyError;
    }
  }

  // 4. Fetch Sólides Jobs (vagas.solides.com.br) if sourceFilter is 'all' or 'solides'
  let solidesJobs: Job[] = [];
  let solidesDiagnostics: SolidesSearchDiagnostics = {
    status: 'ACTIVE',
    publicDiscovery: 'AVAILABLE',
    blockedCount: 0,
    duplicatesRemoved: 0,
    finalSolidesResults: 0,
    durationMs: 0,
    cacheStatus: 'LIVE',
    adapterVersion: 'SOLIDES-BRAZIL-V1',
    expansionStage: 'BRAZIL-SOURCES-V1',
    error: null,
  };
  let solidesError: string | null = null;
  if (sourceFilter === 'all' || sourceFilter === 'solides') {
    try {
      const queryToUse = options.query || (userProfile.targetTitles?.[0] || '');
      const solidesRes = await fetchSolidesJobs({ query: queryToUse, location, daysOld });
      solidesDiagnostics = solidesRes.diagnostics;
      if (solidesRes.ok) {
        solidesJobs = solidesRes.jobs;
      } else {
        solidesError = solidesRes.error || null;
      }
    } catch (err: any) {
      solidesError = err.message || 'Erro ao conectar com Sólides';
      solidesDiagnostics.status = 'ERROR';
      solidesDiagnostics.error = solidesError;
    }
  }

  // 5. Fetch Pandapé Jobs (pandape.infojobs.com.br) if sourceFilter is 'all' or 'pandape'
  let pandapeJobs: Job[] = [];
  let pandapeDiagnostics: PandapeSearchDiagnostics = {
    status: 'ACTIVE',
    publicDiscovery: 'AVAILABLE',
    blockedCount: 0,
    duplicatesRemoved: 0,
    finalPandapeResults: 0,
    tenantsChecked: 1,
    tenantsSuccessful: 1,
    durationMs: 0,
    cacheStatus: 'LIVE',
    adapterVersion: 'PANDAPE-BRAZIL-V1',
    expansionStage: 'BRAZIL-SOURCES-V1',
    error: null,
  };
  let pandapeError: string | null = null;
  if (sourceFilter === 'all' || sourceFilter === 'pandape') {
    try {
      const queryToUse = options.query || (userProfile.targetTitles?.[0] || '');
      const pandapeRes = await fetchPandapeJobs({ query: queryToUse, location, daysOld });
      pandapeDiagnostics = pandapeRes.diagnostics;
      if (pandapeRes.ok) {
        pandapeJobs = pandapeRes.jobs;
      } else {
        pandapeError = pandapeRes.error || null;
      }
    } catch (err: any) {
      pandapeError = err.message || 'Erro ao conectar com Pandapé';
      pandapeDiagnostics.status = 'ERROR';
      pandapeDiagnostics.error = pandapeError;
    }
  }

  // 6. Fetch Remotar Jobs (remotar.com.br) if sourceFilter is 'all' or 'remotar'
  let remotarJobs: Job[] = [];
  let remotarError: string | null = null;
  if (sourceFilter === 'all' || sourceFilter === 'remotar') {
    try {
      const queryToUse = options.query || (userProfile.targetTitles?.[0] || '');
      const remotarRes = await fetchRemotarRaw(queryToUse, daysOld);
      if (remotarRes.ok) {
        remotarJobs = remotarRes.results;
      } else {
        remotarError = remotarRes.error || null;
      }
    } catch (err: any) {
      remotarError = err.message || 'Erro ao conectar com Remotar';
    }
  }

  // 7. Fetch Vagas Remotas Jobs (vagasremotas.com.br / GitHub BR) if sourceFilter is 'all' or 'vagasremotas'
  let vagasRemotasJobs: Job[] = [];
  let vrReposChecked = 0;
  let vrReposSuccessful = 0;
  let vrError: string | null = null;
  if (sourceFilter === 'all' || sourceFilter === 'vagasremotas') {
    try {
      const queryToUse = options.query || (userProfile.targetTitles?.[0] || '');
      const vrRes = await fetchVagasRemotasRaw(queryToUse, daysOld);
      vrReposChecked = vrRes.reposChecked;
      vrReposSuccessful = vrRes.reposSuccessful;
      if (vrRes.ok) {
        vagasRemotasJobs = vrRes.results;
      } else {
        vrError = vrRes.error || null;
      }
    } catch (err: any) {
      vrError = err.message || 'Erro ao conectar com Vagas Remotas';
    }
  }

  // 8. Combine normalized jobs from all active sources (Adzuna + Greenhouse + Gupy + Sólides + Pandapé + Remotar + Vagas Remotas)
  const combinedAllJobs: Job[] = [
    ...normalizedAdzunaJobs,
    ...relevantGhJobs,
    ...gupyJobs,
    ...solidesJobs,
    ...pandapeJobs,
    ...remotarJobs,
    ...vagasRemotasJobs,
  ];

  // Count Brazil-compatible Greenhouse jobs
  const ghBrazilCompatible = relevantGhJobs.filter((j) => {
    const geo = j.geoCategory || classifyGeo(j.location, j.description);
    return geo === 'BRAZIL' || geo === 'REMOTE_BRAZIL' || geo === 'LATAM_COMPATIBLE';
  }).length;

  // 6. Geographic & Location Filtering (GeoClassifier + Search Location Filter)
  const { filteredJobs: geoFilteredJobs, metrics: locationFilterMetrics } = applySearchLocationFilter(
    combinedAllJobs,
    location,
    {
      includeUncertainIntl: options.includeUncertainIntl,
      countryCode: country,
    }
  );

  // 7. Global Deduplication
  const { uniqueJobs, duplicatesRemoved } = deduplicateJobs(geoFilteredJobs);

  // 8. Calculate Score using existing scoring engine
  const jobsWithAnalysis: JobWithAnalysis[] = uniqueJobs.map((job) => {
    const analysis = calculateJobScore(job, userProfile);
    return {
      ...job,
      analysis,
    };
  });

  // 9. Sort by score descending (Ranked)
  jobsWithAnalysis.sort((a, b) => b.analysis.score - a.analysis.score);

  // Background Cloud Sync (Rule 11: Auto save jobs with score >= 75)
  jobsWithAnalysis.forEach((j) => {
    if (j.analysis.score >= 75) {
      syncJobToSupabase(j).catch((err) => {
        console.warn('[CloudSync] Background job auto-save notice:', err);
      });
    }
  });

  const endTime = performance.now();
  const latencyMs = Math.round(endTime - startTime);

  const diagnostics: AdzunaDiagnostics = {
    runtimeSearchHandler: 'SEARCH-HANDLER-V2',
    runtimeBackend: backendData?.runtimeBackend || 'ADZUNA-BACKEND-V2',
    locationFilterRuntime: locationFilterMetrics.locationFilterRuntime || 'LOCATION-FILTER-V2',
    clientEndpoint: backendData?.clientEndpoint || '/api/adzuna/search',
    backendHandler: backendData?.backendHandler || 'server.ts:queryAdzuna',
    credentialsStatus: backendData?.credentialsStatus,
    statusCategory: backendData?.statusCategory || (adzunaApiError ? 'ADZUNA_ERROR' : 'SUCCESS_WITH_RESULTS'),
    httpStatus: backendData?.httpStatus || 200,
    adzunaHttpStatus: backendData?.adzunaHttpStatus ?? null,
    errorStage: backendData?.errorStage || adzunaErrorStage,
    statusText: backendData?.statusText || 'OK',
    countryCode: backendData?.countryCode || country || 'br',
    query: options.query || 'Customer Success',
    location: options.location || '—',
    daysOld: daysOld,
    apiUrlSanitized: backendData?.apiUrlSanitized || `https://api.adzuna.com/v1/api/jobs/${country || 'br'}/search/1`,
    adzunaCount: backendData?.adzunaCount || 0,
    resultsReceived: adzunaRawItems.length,
    normalizedCount: normalizedAdzunaJobs.length,
    duplicatesRemoved,
    finalCount: jobsWithAnalysis.length,
    latencyMs,
    adzunaError: backendData?.adzunaError || adzunaApiError || null,
    routeCheck: adzunaRouteCheck,

    // Expanded Multi-Source Diagnostics
    adzuna: {
      runtimeBackend: backendData?.runtimeBackend || 'ADZUNA-BACKEND-V2',
      clientEndpoint: backendData?.clientEndpoint || '/api/adzuna/search',
      backendHandler: backendData?.backendHandler || 'server.ts:queryAdzuna',
      credentialsStatus: backendData?.credentialsStatus,
      received: adzunaRawItems.length,
      normalized: normalizedAdzunaJobs.length,
      error: backendData?.adzunaError || adzunaApiError || null,
      errorStage: backendData?.errorStage || adzunaErrorStage,
      adzunaHttpStatus: backendData?.adzunaHttpStatus ?? null,
      httpStatus: backendData?.httpStatus || 200,
      routeCheck: adzunaRouteCheck,
    },
    greenhouse: {
      boardsChecked: ghBoardsChecked,
      boardsSuccessful: ghBoardsSuccessful,
      boardsFailed: ghBoardsFailed,
      jobsReceived: ghJobsRaw.length,
      brazilCompatible: ghBrazilCompatible,
      error: ghError,
    },
    gupy: gupyDiagnostics,
    solides: solidesDiagnostics,
    pandape: pandapeDiagnostics,
    remotar: {
      jobsReceived: remotarJobs.length,
      normalized: remotarJobs.length,
      error: remotarError,
    },
    vagasremotas: {
      reposChecked: vrReposChecked,
      reposSuccessful: vrReposSuccessful,
      jobsReceived: vagasRemotasJobs.length,
      normalized: vagasRemotasJobs.length,
      error: vrError,
    },
    locationFilter: locationFilterMetrics,
    global: {
      beforeLocationFilter: combinedAllJobs.length,
      beforeDeduplication: geoFilteredJobs.length,
      duplicatesRemoved,
      finalCount: jobsWithAnalysis.length,
      latencyMs,
    },
  };

  // If Gupy failed and user strictly requested Gupy only, return error
  if (sourceFilter === 'gupy' && gupyJobs.length === 0 && gupyError) {
    return {
      ok: false,
      jobs: [],
      error: gupyError,
      errorCode: 'GUPY_ERROR',
      errorStage: 'BACKEND_PROXY',
      diagnostics,
    };
  }

  // If Solides failed and user strictly requested Solides only, return error
  if (sourceFilter === 'solides' && solidesJobs.length === 0 && solidesError) {
    return {
      ok: false,
      jobs: [],
      error: solidesError,
      errorCode: 'SOLIDES_ERROR',
      errorStage: 'BACKEND_PROXY',
      diagnostics,
    };
  }

  // If Pandape failed and user strictly requested Pandape only, return error
  if (sourceFilter === 'pandape' && pandapeJobs.length === 0 && pandapeError) {
    return {
      ok: false,
      jobs: [],
      error: pandapeError,
      errorCode: 'PANDAPE_ERROR',
      errorStage: 'BACKEND_PROXY',
      diagnostics,
    };
  }

  // If Adzuna failed and user strictly requested Adzuna only, return error
  if (sourceFilter === 'adzuna' && !backendData?.ok && adzunaApiError) {
    return {
      ok: false,
      jobs: [],
      error: adzunaApiError,
      errorCode: backendData?.statusCategory || 'ADZUNA_ERROR',
      errorStage: backendData?.errorStage || adzunaErrorStage,
      diagnostics,
    };
  }

  return {
    ok: true,
    jobs: jobsWithAnalysis,
    diagnostics,
  };
}
