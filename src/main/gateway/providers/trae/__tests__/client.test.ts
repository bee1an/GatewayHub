import { describe, expect, it } from 'vitest'
import { parseModelListPayload } from '../client'

describe('trae/client', () => {
  it('parses model_list payloads from Trae IDE schema variants', () => {
    expect(
      parseModelListPayload({
        code: 0,
        message: 'success',
        model_configs: [
          {
            model_name: 'DeepSeek-V3.2',
            enabled: true,
            status: 'available',
            description: 'premium reasoning model'
          },
          { modelName: 'Gemini-2.5-Flash' },
          { model_name: 'GPT-5.4', enabled: false }
        ]
      })
    ).toEqual(['deepseek-v3.2', 'gemini_2.5_flash'])
  })

  it('parses get_detail_param chat completion configs without exposing internal variants', () => {
    expect(
      parseModelListPayload({
        Result: {
          config_info_list: [
            {
              config_name: 'gemini-2.5-pro-latest',
              usage: 'chat_completion',
              display_config: { display_name: 'Gemini-2.5-Pro' },
              model_detail_list: [
                { model_name: 'gemini-2.5-pro-latest__doller__dev' },
                { model_name: 'gemini-2.5-pro-latest__max' }
              ]
            },
            {
              config_name: 'gemini_2.5_flash',
              usage: 'chat_completion',
              display_config: { display_name: 'Gemini-2.5-Flash' }
            },
            { config_name: 'summary', usage: 'summary', model_name: 'deepseek-V3' },
            { config_name: 'hidden-chat', usage: 'chat_completion', invisible: true }
          ]
        }
      })
    ).toEqual(['gemini-2.5-pro-latest', 'gemini_2.5_flash'])
  })

  it('parses nested function model lists', () => {
    expect(
      parseModelListPayload({
        data: {
          functionModelList: {
            chat: {
              selectables: [{ id: 'kimi-k2.5' }, { name: 'Dola-Seed-2.0-Code' }]
            }
          }
        }
      })
    ).toEqual(['dola-seed-2.0-code', 'kimi-k2'])
  })

  it('parses object maps without treating schema or metadata strings as models', () => {
    expect(
      parseModelListPayload({
        data: {
          models: {
            'DeepSeek-V3.2': { status: 'available', title: 'DeepSeek chat' },
            'GPT-5.4': { available: false },
            meta: { message: 'success' }
          }
        }
      })
    ).toEqual(['deepseek-v3.2'])
  })
})
