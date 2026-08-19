import { Job, SeniorityLevel, WorkplaceType, SolidesRawJob, SolidesSearchDiagnostics } from '../types';
import { classifyGeo } from './geoClassifier';

export interface SolidesFetchOptions {
  query?: string;
  location?: string;
  limit?: number;
  daysOld?: number;
}

export interface SolidesFetchResult {
  ok: boolean;
  httpStatus: number;
  jobs: Job[];
  rawCount: number;
  diagnostics: SolidesSearchDiagnostics;
  error?: string;
}

function cleanText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Infer WorkplaceType for Sólides vacancies.
 */
export function inferSolidesWorkplaceType(
  rawWorkplace?: string,
  isRemote?: boolean,
  title?: string,
  description?: string,
  location?: string
): WorkplaceType {
  const combined = `${rawWorkplace || ''} ${title || ''} ${description || ''} ${location || ''}`.toLowerCase();

  if (isRemote === true || combined.includes('remoto') || combined.includes('remote') || combined.includes('100% remoto') || combined.includes('home office')) {
    return 'Remoto';
  }
  if (combined.includes('híbrido') || combined.includes('hibrido') || combined.includes('hybrid')) {
    return 'Híbrido';
  }
  return 'Presencial';
}

/**
 * Infer SeniorityLevel for Sólides vacancies.
 */
export function inferSolidesSeniority(
  rawType?: string,
  title?: string,
  description?: string
): SeniorityLevel {
  const combined = `${rawType || ''} ${title || ''} ${description || ''}`.toLowerCase();

  if (combined.includes('estágio') || combined.includes('estagio') || combined.includes('intern') || combined.includes('trainee')) {
    return 'Estágio';
  }
  if (combined.includes('júnior') || combined.includes('junior') || combined.includes('jr')) {
    return 'Júnior';
  }
  if (combined.includes('especialista') || combined.includes('specialist') || combined.includes('staff')) {
    return 'Especialista';
  }
  if (combined.includes('liderança') || combined.includes('tech lead') || combined.includes('coordenador') || combined.includes('gerente') || combined.includes('diretor')) {
    return 'Liderança';
  }
  if (combined.includes('sênior') || combined.includes('senior') || combined.includes('sr')) {
    return 'Sênior';
  }
  return 'Pleno';
}

/**
 * Format Sólides location string.
 */
export function formatSolidesLocation(
  city?: string,
  state?: string,
  isRemote?: boolean
): string {
  if (isRemote) {
    return city && state ? `${city}, ${state} (Remoto)` : 'Brasil (100% Remoto)';
  }
  if (city && state) {
    return `${city}, ${state}`;
  }
  if (city) return city;
  if (state) return `${state}, Brasil`;
  return 'Brasil';
}

/**
 * Extract requirements from description.
 */
export function extractSolidesRequirements(
  title: string,
  description: string
): string[] {
  const reqs = new Set<string>();

  const techKeywords = [
    'React', 'TypeScript', 'Node.js', 'Python', 'Java', 'SQL', 'PostgreSQL', 'AWS',
    'Customer Success', 'CRM', 'Salesforce', 'HubSpot', 'Excel', 'Power BI',
    'Gestão de Contas', 'Onboarding', 'Comunicação Interpessoal', 'Scrum'
  ];

  const descLower = description.toLowerCase();
  for (const kw of techKeywords) {
    if (descLower.includes(kw.toLowerCase()) && reqs.size < 6) {
      reqs.add(kw);
    }
  }

  if (reqs.size === 0) {
    reqs.add('Vaga cadastrada na plataforma oficial Sólides');
    reqs.add('Requisitos disponíveis no link da vaga');
  }

  return Array.from(reqs).slice(0, 6);
}

/**
 * Normalizes a raw Sólides job into the canonical Job model.
 */
export function normalizeSolidesJob(raw: SolidesRawJob): Job {
  const title = cleanText(raw.title || raw.name || 'Oportunidade Profissional');
  const company = cleanText(raw.company || raw.company_name || 'Empresa via Sólides');
  const description = cleanText(raw.description || 'Descrição detalhada disponível na página da vaga na plataforma Sólides.');
  const location = formatSolidesLocation(raw.city, raw.state, raw.is_remote);
  const workplaceType = inferSolidesWorkplaceType(raw.workplace_type, raw.is_remote, title, description, location);
  const seniority = inferSolidesSeniority(raw.type, title, description);
  const requirements = extractSolidesRequirements(title, description);

  let pubDateStr = raw.created_at || new Date().toISOString().split('T')[0];
  if (pubDateStr.includes('T')) {
    pubDateStr = pubDateStr.split('T')[0];
  }

  const jobUrl = raw.url || raw.link || `https://vagas.solides.com.br/vaga/${raw.id || encodeURIComponent(title)}`;
  const geoCategory = classifyGeo(location, description);

  return {
    id: `solides-${raw.id}`,
    title,
    company,
    location,
    workplaceType,
    seniority,
    description: description.substring(0, 1500),
    requirements,
    url: jobUrl,
    publishedAt: pubDateStr,
    salaryRange: raw.salary ? String(raw.salary) : undefined,
    source: 'solides',
    sources: ['solides'],
    discovery_source: 'Sólides (vagas.solides.com.br)',
    geoCategory,
  };
}

/**
 * Fetches jobs from the Sólides source via backend proxy.
 */
export async function fetchSolidesJobs(options: SolidesFetchOptions = {}): Promise<SolidesFetchResult> {
  const startTime = Date.now();
  const query = options.query?.trim() || '';
  const location = options.location?.trim() || '';
  const limit = options.limit || 50;
  const daysOld = options.daysOld || 30;

  try {
    const response = await fetch('/api/solides/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, location, limit, daysOld }),
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        jobs: [],
        rawCount: 0,
        diagnostics: {
          status: 'ERROR',
          publicDiscovery: 'AVAILABLE',
          blockedCount: 0,
          duplicatesRemoved: 0,
          finalSolidesResults: 0,
          durationMs,
          cacheStatus: 'LIVE',
          adapterVersion: 'SOLIDES-BRAZIL-V1',
          expansionStage: 'BRAZIL-SOURCES-V1',
          error: `HTTP ${response.status}`,
        },
        error: `Erro ao consultar Sólides (HTTP ${response.status})`,
      };
    }

    const data = await response.json();
    const rawList: SolidesRawJob[] = Array.isArray(data.results) ? data.results : [];
    const normalizedJobs: Job[] = rawList.map(normalizeSolidesJob);

    return {
      ok: true,
      httpStatus: 200,
      jobs: normalizedJobs,
      rawCount: rawList.length,
      diagnostics: {
        status: normalizedJobs.length > 0 ? 'ACTIVE' : 'EMPTY',
        publicDiscovery: 'AVAILABLE',
        blockedCount: 0,
        duplicatesRemoved: 0,
        finalSolidesResults: normalizedJobs.length,
        durationMs,
        cacheStatus: 'LIVE',
        adapterVersion: 'SOLIDES-BRAZIL-V1',
        expansionStage: 'BRAZIL-SOURCES-V1',
        error: null,
      },
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    return {
      ok: false,
      httpStatus: 500,
      jobs: [],
      rawCount: 0,
      diagnostics: {
        status: 'ERROR',
        publicDiscovery: 'AVAILABLE',
        blockedCount: 0,
        duplicatesRemoved: 0,
        finalSolidesResults: 0,
        durationMs,
        cacheStatus: 'LIVE',
        adapterVersion: 'SOLIDES-BRAZIL-V1',
        expansionStage: 'BRAZIL-SOURCES-V1',
        error: err.message || 'Exceção de rede ao conectar com Sólides',
      },
      error: err.message || 'Falha ao conectar com o serviço Sólides',
    };
  }
}
