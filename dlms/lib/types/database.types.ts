// Generated from Supabase schema. Re-generate with: npm run db:types

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_user: {
        Row: {
          active: boolean
          created_at: string
          email: string
          id: string
          role: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email: string
          id: string
          role: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string
          id?: string
          role?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          changed_columns: string[]
          id: string
          new_values: Json
          occurred_at: string
          old_values: Json | null
          request_id: string | null
          row_id: string
          table_name: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          changed_columns?: string[]
          id?: string
          new_values: Json
          occurred_at?: string
          old_values?: Json | null
          request_id?: string | null
          row_id: string
          table_name: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          changed_columns?: string[]
          id?: string
          new_values?: Json
          occurred_at?: string
          old_values?: Json | null
          request_id?: string | null
          row_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
        ]
      }
      device: {
        Row: {
          build_date: string | null
          created_at: string
          created_by: string
          customer: string | null
          deleted_at: string | null
          destination: string | null
          device_sn: string | null
          device_sn_normalized: string | null
          hmi_ver: string | null
          id: string
          model_no: string | null
          next_service_date: string | null
          pcba_a_bom_rev: string
          pcba_a_fw_ver: string
          pcba_a_hw_rev: string
          pcba_a_sn: string
          pcba_a_sn_normalized: string
          pcba_b_bom_rev: string | null
          pcba_b_fw_ver: string | null
          pcba_b_hw_rev: string | null
          pcba_b_sn: string | null
          pcba_b_sn_normalized: string | null
          phase: string
          product_name: string | null
          qty: number | null
          remarks: string | null
          replaced_by: string | null
          screen_model: string | null
          ship_date: string | null
          status: string
          updated_at: string
          updated_by: string | null
          version: number
          warranty_expiry: string | null
        }
        Insert: {
          build_date?: string | null
          created_at?: string
          created_by: string
          customer?: string | null
          deleted_at?: string | null
          destination?: string | null
          device_sn?: string | null
          device_sn_normalized?: string | null
          hmi_ver?: string | null
          id?: string
          model_no?: string | null
          next_service_date?: string | null
          pcba_a_bom_rev: string
          pcba_a_fw_ver: string
          pcba_a_hw_rev: string
          pcba_a_sn: string
          pcba_a_sn_normalized?: string
          pcba_b_bom_rev?: string | null
          pcba_b_fw_ver?: string | null
          pcba_b_hw_rev?: string | null
          pcba_b_sn?: string | null
          pcba_b_sn_normalized?: string | null
          phase: string
          product_name?: string | null
          qty?: number | null
          remarks?: string | null
          replaced_by?: string | null
          screen_model?: string | null
          ship_date?: string | null
          status: string
          updated_at?: string
          updated_by?: string | null
          version?: number
          warranty_expiry?: string | null
        }
        Update: {
          build_date?: string | null
          created_at?: string
          created_by?: string
          customer?: string | null
          deleted_at?: string | null
          destination?: string | null
          device_sn?: string | null
          device_sn_normalized?: string | null
          hmi_ver?: string | null
          id?: string
          model_no?: string | null
          next_service_date?: string | null
          pcba_a_bom_rev?: string
          pcba_a_fw_ver?: string
          pcba_a_hw_rev?: string
          pcba_a_sn?: string
          pcba_a_sn_normalized?: string
          pcba_b_bom_rev?: string | null
          pcba_b_fw_ver?: string | null
          pcba_b_hw_rev?: string | null
          pcba_b_sn?: string | null
          pcba_b_sn_normalized?: string | null
          phase?: string
          product_name?: string | null
          qty?: number | null
          remarks?: string | null
          replaced_by?: string | null
          screen_model?: string | null
          ship_date?: string | null
          status?: string
          updated_at?: string
          updated_by?: string | null
          version?: number
          warranty_expiry?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_phase_fkey"
            columns: ["phase"]
            isOneToOne: false
            referencedRelation: "phase_option"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "device_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "device"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_status_fkey"
            columns: ["status"]
            isOneToOne: false
            referencedRelation: "status_option"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "device_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
        ]
      }
      device_assignment: {
        Row: {
          assigned_at: string
          assigned_by: string
          device_id: string
          id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by: string
          device_id: string
          id?: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string
          device_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_assignment_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_assignment_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_assignment_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
        ]
      }
      device_filter_preset: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          query_string: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          query_string?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          query_string?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_filter_preset_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
        ]
      }
      device_stats_daily: {
        Row: {
          device_count: number
          phase: string
          snapshot_date: string
          status: string
          unit_count: number
        }
        Insert: {
          device_count?: number
          phase: string
          snapshot_date: string
          status: string
          unit_count?: number
        }
        Update: {
          device_count?: number
          phase?: string
          snapshot_date?: string
          status?: string
          unit_count?: number
        }
        Relationships: []
      }
      extracted_device_draft: {
        Row: {
          corrections: Json | null
          created_at: string
          extracted_payload: Json
          extraction_model_version: string | null
          id: string
          promoted_device_id: string | null
          reviewed_by: string | null
          source_file_hash: string
          source_file_path: string
          status: string
          updated_at: string
        }
        Insert: {
          corrections?: Json | null
          created_at?: string
          extracted_payload: Json
          extraction_model_version?: string | null
          id?: string
          promoted_device_id?: string | null
          reviewed_by?: string | null
          source_file_hash: string
          source_file_path: string
          status?: string
          updated_at?: string
        }
        Update: {
          corrections?: Json | null
          created_at?: string
          extracted_payload?: Json
          extraction_model_version?: string | null
          id?: string
          promoted_device_id?: string | null
          reviewed_by?: string | null
          source_file_hash?: string
          source_file_path?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "extracted_device_draft_promoted_device_id_fkey"
            columns: ["promoted_device_id"]
            isOneToOne: false
            referencedRelation: "device"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extracted_device_draft_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
        ]
      }
      phase_option: {
        Row: {
          active: boolean
          code: string
          label_en: string
          label_zh: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          code: string
          label_en: string
          label_zh: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          code?: string
          label_en?: string
          label_zh?: string
          sort_order?: number
        }
        Relationships: []
      }
      report_subscriber: {
        Row: {
          active: boolean
          created_at: string
          email: string
          id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email: string
          id?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string
          id?: string
        }
        Relationships: []
      }
      service_event: {
        Row: {
          created_at: string
          created_by: string
          description: string
          device_id: string
          id: string
          occurred_on: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description: string
          device_id: string
          id?: string
          occurred_on?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string
          device_id?: string
          id?: string
          occurred_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_event_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_event_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device"
            referencedColumns: ["id"]
          },
        ]
      }
      status_option: {
        Row: {
          active: boolean
          code: string
          label_en: string
          label_zh: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          code: string
          label_en: string
          label_zh: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          code?: string
          label_en?: string
          label_zh?: string
          sort_order?: number
        }
        Relationships: []
      }
      warranty_notification: {
        Row: {
          device_id: string
          notified_at: string
        }
        Insert: {
          device_id: string
          notified_at?: string
        }
        Update: {
          device_id?: string
          notified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "warranty_notification_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: true
            referencedRelation: "device"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_current_distribution: {
        Row: {
          device_count: number | null
          phase: string | null
          phase_label_en: string | null
          phase_label_zh: string | null
          status: string | null
          status_label_en: string | null
          status_label_zh: string | null
          unit_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "device_phase_fkey"
            columns: ["phase"]
            isOneToOne: false
            referencedRelation: "phase_option"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "device_status_fkey"
            columns: ["status"]
            isOneToOne: false
            referencedRelation: "status_option"
            referencedColumns: ["code"]
          },
        ]
      }
      v_daily_throughput: {
        Row: {
          day: string | null
          devices_completed: number | null
          devices_created: number | null
        }
        Relationships: []
      }
      v_phase_transition: {
        Row: {
          actor_id: string | null
          device_id: string | null
          from_phase: string | null
          occurred_at: string | null
          to_phase: string | null
        }
        Relationships: []
      }
      v_status_dwell: {
        Row: {
          device_id: string | null
          dwell_interval: string | null
          entered_at: string | null
          exited_at: string | null
          status: string | null
        }
        Relationships: []
      }
      v_status_transition: {
        Row: {
          actor_id: string | null
          device_id: string | null
          from_status: string | null
          occurred_at: string | null
          to_status: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      auth_user_role: { Args: never; Returns: string }
      fn_snapshot_device_stats: { Args: never; Returns: undefined }
      uuid_generate_v4: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
