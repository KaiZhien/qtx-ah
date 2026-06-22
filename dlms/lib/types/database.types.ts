// Generated from Supabase schema. Re-generate with: npm run db:types

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      app_user: {
        Row: {
          id: string
          email: string
          role: string
          active: boolean
          created_at: string
        }
        Insert: {
          id: string
          email: string
          role: string
          active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          email?: string
          role?: string
          active?: boolean
          created_at?: string
        }
      }
      status_option: {
        Row: {
          code: string
          label_en: string
          label_zh: string
          sort_order: number
          active: boolean
        }
        Insert: {
          code: string
          label_en: string
          label_zh: string
          sort_order?: number
          active?: boolean
        }
        Update: {
          code?: string
          label_en?: string
          label_zh?: string
          sort_order?: number
          active?: boolean
        }
      }
      phase_option: {
        Row: {
          code: string
          label_en: string
          label_zh: string
          sort_order: number
          active: boolean
        }
        Insert: {
          code: string
          label_en: string
          label_zh: string
          sort_order?: number
          active?: boolean
        }
        Update: {
          code?: string
          label_en?: string
          label_zh?: string
          sort_order?: number
          active?: boolean
        }
      }
      device: {
        Row: {
          id: string
          created_at: string
          created_by: string
          updated_at: string
          updated_by: string | null
          deleted_at: string | null
          version: number
          device_sn: string | null
          product_name: string | null
          model_no: string | null
          pcba_a_sn: string
          pcba_a_hw_rev: string
          pcba_a_bom_rev: string
          pcba_a_fw_ver: string
          pcba_b_sn: string | null
          pcba_b_hw_rev: string | null
          pcba_b_bom_rev: string | null
          pcba_b_fw_ver: string | null
          screen_model: string | null
          hmi_ver: string | null
          build_date: string | null
          ship_date: string | null
          qty: number | null
          destination: string | null
          customer: string | null
          status: string
          phase: string
          remarks: string | null
          device_sn_normalized: string | null
          pcba_a_sn_normalized: string
          pcba_b_sn_normalized: string | null
        }
        Insert: {
          id?: string
          created_at?: string
          created_by: string
          updated_at?: string
          updated_by?: string | null
          deleted_at?: string | null
          version?: number
          device_sn?: string | null
          product_name?: string | null
          model_no?: string | null
          pcba_a_sn: string
          pcba_a_hw_rev: string
          pcba_a_bom_rev: string
          pcba_a_fw_ver: string
          pcba_b_sn?: string | null
          pcba_b_hw_rev?: string | null
          pcba_b_bom_rev?: string | null
          pcba_b_fw_ver?: string | null
          screen_model?: string | null
          hmi_ver?: string | null
          build_date?: string | null
          ship_date?: string | null
          qty?: number | null
          destination?: string | null
          customer?: string | null
          status: string
          phase: string
          remarks?: string | null
          device_sn_normalized?: string | null
          pcba_a_sn_normalized?: string
          pcba_b_sn_normalized?: string | null
        }
        Update: {
          id?: string
          created_at?: string
          created_by?: string
          updated_at?: string
          updated_by?: string | null
          deleted_at?: string | null
          version?: number
          device_sn?: string | null
          product_name?: string | null
          model_no?: string | null
          pcba_a_sn?: string
          pcba_a_hw_rev?: string
          pcba_a_bom_rev?: string
          pcba_a_fw_ver?: string
          pcba_b_sn?: string | null
          pcba_b_hw_rev?: string | null
          pcba_b_bom_rev?: string | null
          pcba_b_fw_ver?: string | null
          screen_model?: string | null
          hmi_ver?: string | null
          build_date?: string | null
          ship_date?: string | null
          qty?: number | null
          destination?: string | null
          customer?: string | null
          status?: string
          phase?: string
          remarks?: string | null
          device_sn_normalized?: string | null
          pcba_a_sn_normalized?: string
          pcba_b_sn_normalized?: string | null
        }
      }
      audit_log: {
        Row: {
          id: string
          actor_id: string | null
          action: string
          table_name: string
          row_id: string
          old_values: Json | null
          new_values: Json
          changed_columns: string[]
          request_id: string | null
          occurred_at: string
        }
        Insert: {
          id?: string
          actor_id?: string | null
          action: string
          table_name: string
          row_id: string
          old_values?: Json | null
          new_values: Json
          changed_columns?: string[]
          request_id?: string | null
          occurred_at?: string
        }
        Update: {
          id?: string
          actor_id?: string | null
          action?: string
          table_name?: string
          row_id?: string
          old_values?: Json | null
          new_values?: Json
          changed_columns?: string[]
          request_id?: string | null
          occurred_at?: string
        }
      }
      extracted_device_draft: {
        Row: {
          id: string
          source_file_path: string
          source_file_hash: string
          status: string
          extracted_payload: Json
          extraction_model_version: string | null
          reviewed_by: string | null
          promoted_device_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          source_file_path: string
          source_file_hash: string
          status?: string
          extracted_payload: Json
          extraction_model_version?: string | null
          reviewed_by?: string | null
          promoted_device_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          source_file_path?: string
          source_file_hash?: string
          status?: string
          extracted_payload?: Json
          extraction_model_version?: string | null
          reviewed_by?: string | null
          promoted_device_id?: string | null
          created_at?: string
          updated_at?: string
        }
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']
