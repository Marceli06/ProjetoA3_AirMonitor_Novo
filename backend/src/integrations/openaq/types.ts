// Tipos da resposta BRUTA da OpenAQ v3. Usados somente dentro da integração:
// o frontend nunca recebe esses formatos (ver mapper.ts).

export interface OpenAQDatetime {
  utc: string;
  local: string;
}

export interface OpenAQCoordinates {
  latitude: number;
  longitude: number;
}

export interface OpenAQParameter {
  id: number;
  name: string;
  units: string;
  displayName?: string | null;
}

export interface OpenAQSensor {
  id: number;
  name: string;
  parameter: OpenAQParameter;
}

export interface OpenAQLocation {
  id: number;
  name: string | null;
  locality?: string | null;
  timezone?: string | null;
  country?: { id: number; code: string; name: string } | null;
  isMobile?: boolean | null;
  isMonitor?: boolean | null;
  sensors?: OpenAQSensor[] | null;
  coordinates?: OpenAQCoordinates | null;
  distance?: number | null;
  datetimeFirst?: OpenAQDatetime | null;
  datetimeLast?: OpenAQDatetime | null;
}

export interface OpenAQLatest {
  datetime: OpenAQDatetime;
  value: number;
  coordinates?: OpenAQCoordinates | null;
  sensorsId: number;
  locationsId: number;
}

// Medição histórica de um sensor (GET /sensors/{id}/measurements) — usada na etapa de histórico
export interface OpenAQMeasurement {
  value: number;
  parameter?: { id: number; name: string; units: string } | null;
  period?: {
    label?: string;
    datetimeFrom?: OpenAQDatetime | null;
    datetimeTo?: OpenAQDatetime | null;
  } | null;
  coordinates?: OpenAQCoordinates | null;
}

export interface OpenAQListResponse<T> {
  meta?: { name?: string; page?: number; limit?: number | string; found?: number | string };
  results: T[];
}
